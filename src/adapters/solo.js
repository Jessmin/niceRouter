import { config } from '../config.js';
import { readJsonEvents } from '../sse.js';
import { traeQuota, traeCheckin } from '../quota.js';
import { toolsToUpstream, toolChoiceHint, ToolMarkupSieve } from '../toolcall.js';
import { createSoloReasoningBridge, createSoloReasoningStats } from '../solo-reasoning.js';

const reasoningBridge = createSoloReasoningBridge();

/**
 * Trae CN — solo_agent 通道适配器
 * ------------------------------------------------------------------
 * 端点：POST /api/agent/v3/llm_utils_chat
 * 关键发现：这个端点看起来在传密文（base64 后熵 7.99），但**服务端同时接受明文 JSON**。
 *          所以完全不需要逆向 harness.dll 里的加解密。
 *
 * 请求体（明文）：
 *   {
 *     "function": "solo_agent",                     // 服务端注册的路由键，写错会 2001
 *     "model_name": "deepseek-v4.1-flash__dev",     // 必须是 get_detail_param 下发的真实名
 *     "messages": [{"role":"user","content":[{"type":"text","text":"..."}]}]
 *   }
 * 注意 messages[].content 必须是数组（[]*idecopilot.LLMRawMessageContent），传字符串会 4001。
 *
 * 响应事件：
 *   output              -> {response, reasoning_content, tool_calls, phase}   增量
 *   queue_begin         -> {queue_id}
 *   request_wait_in_queue -> {position, message}                              排队中
 *   token_usage         -> {prompt_tokens, completion_tokens, reasoning_tokens}
 *   timing_cost         -> 含 queue_timing / provider_model_name
 *   done                -> {finish_reason}
 *   error               -> {code, message}
 *
 * 排队：间歇性的，不是每次都有。免费档（fast_request_per=0）进公共池，
 *       position 是全平台人数（实测见过 250+），但推进很快——107→42 约 20 秒；
 *       也经常直接 queue_timing=13ms 秒回。详见 README「排队到底是怎么回事」。
 */

const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
};

/** OpenAI messages -> Trae agent 的 [{role, content:[{type:'text',text}]}] */
export function toSoloMessages(messages, { toolPrompt = '', toolChoice = null, toolNameList = [], reasoningScope = null, reasoningStats = null, reasoningReplayAllowed = false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const systems = list.filter((m) => m.role === 'system' || m.role === 'developer');
  const dialog = list.filter((m) => m.role !== 'system' && m.role !== 'developer');
  const hint = toolChoiceHint(toolChoice, toolNameList);
  const sysText = [...systems.map((m) => textOf(m.content)).filter(Boolean), toolPrompt, hint]
    .filter(Boolean)
    .join('\n\n');

  const out = [];
  dialog.forEach((m) => {
    if (m.role === 'user') {
      let text = textOf(m.content);
      // agent 通道没有独立的 system 位，把系统设定并进第一条用户消息
      if (!out.length && sysText) text = `[系统设定]\n${sysText}\n\n[用户]\n${text}`;
      out.push({ role: 'user', content: [{ type: 'text', text }] });
      return;
    }

    if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const text = textOf(m.content);
      const extraInfo = reasoningBridge.extraInfoFor(m, reasoningScope, reasoningStats, { allowReplay: reasoningReplayAllowed });
      if (!text && !calls.length && !extraInfo) return;
      const msg = { role: 'assistant', content: text ? [{ type: 'text', text }] : [] };
      if (extraInfo) msg.extra_info = extraInfo;
      if (calls.length) {
        // 键名必须是 function_call（function 会被上游忽略 → required field Name is not set）
        msg.tool_calls = calls.map((c, i) => {
          const fn = c.function || c.function_call || {};
          return {
            id: c.id || `call_${i}`,
            type: 'function',
            function_call: {
              name: fn.name || '',
              arguments:
                typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
            },
          };
        });
      }
      out.push(msg);
      return;
    }

    if (m.role === 'tool' || m.role === 'function') {
      // 工具结果回灌：之前这里被整体过滤，导致多轮工具调用第二轮必然丢上下文
      const text = textOf(m.content);
      const msg = { role: 'tool', content: [{ type: 'text', text }] };
      if (m.tool_call_id) msg.tool_call_id = String(m.tool_call_id);
      else if (m.name) msg.name = String(m.name);
      out.push(msg);
    }
  });

  // 首条必须是 user，否则上游会把它当成续写
  if (out.length && out[0].role !== 'user') {
    const prefix = sysText ? `[系统设定]\n${sysText}\n\n` : '';
    out.unshift({ role: 'user', content: [{ type: 'text', text: `${prefix}(继续)` }] });
  }
  return out;
}

export function soloModelNames() {
  // 对象数组（含 display/type），server.js 聚合时要用
  return config.soloModels;
}

/** 取消排队，避免关掉页面后还占着队列 */
async function cancelQueue(queueId) {
  const cfg = config.trae;
  try {
    await fetch(cfg.base.replace(/\/$/, '') + '/api/ide/v1/cancel_queue_task', {
      method: 'POST',
      headers: { ...cfg.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ queue_id: queueId, Request: {} }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // 取消失败无所谓
  }
}

async function* streamSoloAttempt({ model, messages, signal, tools, functions, toolChoice, timeoutMs = config.solo.timeoutMs }) {
  const cfg = config.trae;
  if (!cfg.token) {
    throw new Error('缺少 token：请在 config/trae-session.json 的 headers.authorization 里填入 Cloud-IDE-JWT <token>');
  }

  // 原生 tools：parameters 必须序列化成字符串，否则上游 4001
  const upTools = toolsToUpstream(tools, functions);
  const toolNameList = upTools.map((t) => t.function.name);
  const useNative = upTools.length > 0 && toolChoice !== 'none';
  const authorization = new Headers(cfg.headers).get('authorization') || '';
  // Either configured credential changing invalidates the profile. Only a hash
  // of this scope is retained, never the token/header or reasoning content.
  const reasoningScope = { token: JSON.stringify([cfg.token, authorization]), model,
    route: JSON.stringify([cfg.base, config.solo.chatPath, config.solo.function]) };
  const reasoningStats = createSoloReasoningStats();

  const body = {
    function: config.solo.function,
    model_name: model,
    messages: toSoloMessages(messages, { toolChoice, toolNameList, reasoningScope, reasoningStats, reasoningReplayAllowed: useNative }),
  };
  if (useNative) body.tools = upTools;
  const url = cfg.base.replace(/\/$/, '') + config.solo.chatPath;
  yield { upstreamMeta: reasoningStats };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();

  let res;
  const fetchStarted = performance.now();
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        ...cfg.headers,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'accept-encoding': 'identity',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (e?.name === 'AbortError') throw new Error('上游超时或已取消（solo 通道排队可能很久，可用 TRAE_TIMEOUT_MS 调大）');
    throw e;
  }

  if (!res.ok) {
    try {
      const errText = await res.text().catch(() => '');
      throw new Error(`solo 上游 ${res.status} ${res.statusText}: ${errText.slice(0, 600)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  let queueId = '';
  let finished = false;
  let lastPos = -1;
  // 正文里泄漏的原生标记（<seed:tool_call>…</seed:tool_call>）走筛子还原成工具调用。
  // 没有声明任何工具时仍解析标记（恢复轮模型可能照样发起调用），交给客户端决定；
  // 只有显式 toolChoice=none 才完全不接文本协议。
  const sieve = new ToolMarkupSieve({ allowedNames: useNative ? toolNameList : (upTools.length === 0 ? null : []), tools, functions });
  let toolBoundary = false;
  let fallbackIdx = 0;

  try {
    yield { timing: { upstream_headers_ms: performance.now() - fetchStarted } };
    for await (const evt of readJsonEvents(res.body)) {
      const name = evt.__event || '';

      if (name === 'error' || (typeof evt.code === 'number' && evt.code >= 2000 && !evt.response)) {
        throw new Error(`solo 上游拒绝：${evt.message || `错误码 ${evt.code}`}`);
      }

      if (name === 'queue_begin') {
        queueId = evt.queue_id || '';
        continue;
      }

      if (name === 'request_wait_in_queue') {
        const pos = typeof evt.position === 'number' ? evt.position : -1;
        if (pos >= 0 && pos !== lastPos) {
          lastPos = pos;
          // position 是全平台排队人数，推进很快（实测 107→42 约 20 秒），提示别中断
          yield { status: `排队中，前面还有 ${pos} 个请求（会自动推进，别中断）` };
        }
        continue;
      }

      if (name === 'timing_cost') {
        // 出队后才下发，queue_timing 是纯排队毫秒数
        const qt = Number(evt.queue_timing || 0);
        yield { timing: { queue_ms: qt } };
        if (typeof evt.provider_model_name === 'string') yield { upstreamMeta: { providerModelName: evt.provider_model_name.slice(0, 256) } };
        if (qt >= 1500) yield { status: `上游排队 ${(qt / 1000).toFixed(1)} 秒后开始输出` };
        continue;
      }

      if (name === 'queue_end') continue;

      if (name === 'extra_info') {
        reasoningBridge.learn(reasoningScope, evt);
        yield { upstreamMeta: {
          extraInfoPresent: true,
          ...(typeof evt.model === 'string' ? { extraInfoModel: evt.model.slice(0, 256) } : {}),
          ...(typeof evt.version === 'string' ? { extraInfoVersion: evt.version.slice(0, 128) }
            : Number.isFinite(evt.version) ? { extraInfoVersion: evt.version } : {}),
          ...(Number.isFinite(evt.input_token) && evt.input_token >= 0 ? { extraInfoInputTokens: evt.input_token } : {}),
        } };
        continue;
      }

      if (name === 'output') {
        const rc = evt.reasoning_content;
        if (typeof rc === 'string' && rc) yield { reasoning: rc };

        // 原生 tool_calls：arguments 是增量，交给 server 侧累加器拼接
        if (Array.isArray(evt.tool_calls) && evt.tool_calls.length) {
          for (const tc of evt.tool_calls) {
            const fc = tc.function_call || tc.function || {};
            const args = fc.arguments;
            yield {
              toolCall: {
                index: Number.isInteger(tc.index) ? tc.index : 0,
                id: tc.id || '',
                type: tc.type || 'function',
                name: fc.name || '',
                arguments:
                  typeof args === 'string' ? args : args == null ? '' : JSON.stringify(args),
              },
            };
          }
        }

        const txt = evt.response;
        if (typeof txt === 'string' && txt) {
          const { text, calls } = sieve.push(txt);
          if (text) yield { text };
          for (const c of calls) {
            yield { toolCall: { index: 1000 + fallbackIdx++, id: c.id, name: c.name, arguments: c.arguments } };
          }
          if (sieve.stopped) {
            toolBoundary = true;
            yield { done: true, finishReason: 'tool_calls', terminationReason: 'tool_turn_boundary' };
            return;
          }
        }
        continue;
      }

      if (name === 'token_usage') {
        if (typeof evt.cluster === 'string') yield { upstreamMeta: { cluster: evt.cluster.slice(0, 128) } };
        const usage = {
          prompt_tokens: evt.prompt_tokens || 0,
          completion_tokens: evt.completion_tokens || 0,
          total_tokens: evt.total_tokens || (evt.prompt_tokens || 0) + (evt.completion_tokens || 0),
        };
        if (Number.isFinite(evt.reasoning_tokens) && evt.reasoning_tokens >= 0) {
          usage.completion_tokens_details = { reasoning_tokens: evt.reasoning_tokens };
        }
        if (usage.total_tokens || usage.completion_tokens_details) yield { usage };
        continue;
      }

      if (name === 'done') {
        finished = true;
        const tail = sieve.flush();
        if (tail.text) yield { text: tail.text };
        // 文本协议的调用是 flush 时才解析出来的：上游不知道，finish_reason 仍是 stop。
        // 这轮真的解析出了调用就按 tool_turn 上报（length/content_filter 不覆盖）。
        const markupCalls = tail.calls.length > 0;
        for (const c of tail.calls) yield { toolCall: { index: 1000 + fallbackIdx++, id: c.id, name: c.name, arguments: c.arguments } };
        const finish = markupCalls && (evt.finish_reason == null || evt.finish_reason === 'stop')
          ? 'tool_calls' : evt.finish_reason;
        yield { done: true, finishReason: finish, upstreamFinishReason: evt.finish_reason,
          terminationReason: markupCalls ? 'tool_turn_boundary' : 'upstream_done' };
        return;
      }
    }
    if (!finished) throw new Error('solo 上游连接提前结束，未收到 done（请重试或检查超时）');
  } finally {
    if (toolBoundary) controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (queueId && !finished && !toolBoundary) cancelQueue(queueId);
  }
}

const REASONING_ONLY_CONTINUE = '上一轮只返回了思考，没有输出可用正文或工具调用。请继续完成原始用户请求，必须输出正文或标准工具调用，本轮禁止仅思考后结束。保留原请求约束，不要编造工具执行结果；工具调用后等待调用方提供真实结果。';

function accumulatedUsage(usages) {
  const result = {};
  let reasoning;
  for (const usage of usages.filter(Boolean)) {
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (Number.isFinite(usage[key]) && usage[key] >= 0) result[key] = (result[key] || 0) + usage[key];
    }
    const count = usage.completion_tokens_details?.reasoning_tokens;
    if (Number.isFinite(count) && count >= 0) reasoning = (reasoning || 0) + count;
  }
  if (reasoning !== undefined) result.completion_tokens_details = { reasoning_tokens: reasoning };
  return result;
}

/** Recover one fully ended, reasoning-only stop without changing the original
 * history/tool chain or interpreting reasoning as instructions. Both attempts
 * share the original deadline; per-attempt latest usage is summed exactly once. */
export async function* streamSolo(params) {
  const deadline = performance.now() + config.solo.timeoutMs;
  const completedUsages = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt > 1) params.signal?.throwIfAborted();
    const started = performance.now();
    const remaining = deadline - started;
    if (remaining <= 0) throw new Error('solo 请求总超时，未继续请求上游');
    const messages = attempt === 1 ? params.messages : [...(Array.isArray(params.messages) ? params.messages : []),
      { role: 'user', content: REASONING_ONLY_CONTINUE }];
    let textChars = 0, reasoningChars = 0, toolDeltas = 0, hasText = false, usage = null, done = null;
    const meta = {};
    const summary = (phase, recoveryRequested = false) => ({ completionAttempt: {
      attempt, phase, route: config.solo.function, model: params.model,
      textChars, reasoningChars, toolDeltas,
      finishReason: done?.upstreamFinishReason ?? done?.finishReason ?? null,
      terminationReason: done?.terminationReason ?? (params.signal?.aborted ? 'client_cancelled' : phase === 'failed' ? 'attempt_error' : null),
      usage, elapsedMs: Math.round(performance.now() - started), recoveryRequested, ...meta,
    } });
    try {
      for await (const event of streamSoloAttempt({ ...params, messages, timeoutMs: remaining })) {
        if (event.upstreamMeta) Object.assign(meta, event.upstreamMeta);
        if (event.done) { done = event; continue; }
        if (event.upstreamMeta) continue;
        if (typeof event.text === 'string') { textChars += event.text.length; hasText ||= Boolean(event.text.trim()); }
        if (event.toolCall) toolDeltas++;
        if (typeof event.reasoning === 'string') {
          reasoningChars += event.reasoning.length;
          // Initial reasoning is already visible to streaming clients. The
          // continuation supplies the answer, without duplicating its thinking.
          if (attempt === 2) continue;
        }
        if (event.usage) {
          usage = event.usage;
          yield { usage: accumulatedUsage([...completedUsages, usage]) };
        } else yield event;
      }
      params.signal?.throwIfAborted();
    } catch (error) {
      yield summary('failed');
      throw error;
    }
    const recover = attempt === 1 && done?.terminationReason === 'upstream_done'
      && done.upstreamFinishReason === 'stop' && reasoningChars > 0 && !hasText && toolDeltas === 0
      && !params.signal?.aborted && performance.now() < deadline;
    yield summary('completed', recover);
    if (!recover) {
      if (done) yield done;
      return;
    }
    completedUsages.push(usage);
    yield { status: '上游上一轮仅返回思考，正在保留完整上下文继续获取正文或工具调用（最多继续一次）' };
  }
}

export const soloAdapter = {
  name: 'solo',
  models: soloModelNames,
  stream: streamSolo,
  quota: traeQuota,
  checkin: traeCheckin,
  // 原生支持 tools / tool_calls（实测 2026-11-04）
  supportsTools: true,
};
