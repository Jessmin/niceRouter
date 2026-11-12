import { readJsonEvents } from '../sse.js';
import { getMiniMaxCodeAuth, hasMiniMaxCodeAuth, minimaxCodeConfig } from '../minimax-code-auth.js';

// The installed MiniMax Code Desktop managed-login presets. These are distinct
// from Open Platform API key and subscription-key endpoints.
const BASES = Object.freeze({
  cn: 'https://agent.minimax.cn/mavis/api/v1/llm/v1',
  global: 'https://agent.minimax.io/mavis/api/v1/llm/v1',
});
const MODELS = [
  { id: 'MiniMax-M3.1-Flash', display: 'MiniMax-M3.1-Flash', type: 'reasoning', context: 512000, maxOutputTokens: 128000 },
  { id: 'MiniMax-M3', display: 'MiniMax-M3', type: 'reasoning', context: 512000, maxOutputTokens: 128000 },
];
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (message, code, status = 502, type = 'upstream_error') => Object.assign(new Error(message), { code, status, type });
const invalid = (message) => error(message, 'minimax_code_invalid_request', 400, 'invalid_request_error');

function contentBlocks(value, role) {
  if (value == null || value === '') return [];
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) throw invalid('MiniMax Code 消息内容须为文本或内容块数组');
  return value.flatMap((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return part.text ? [{ type: 'text', text: part.text }] : [];
    if (role === 'assistant' && part?.type === 'thinking' && typeof part.thinking === 'string'
      && typeof part.signature === 'string' && part.signature) return [{ type: 'thinking', thinking: part.thinking, signature: part.signature }];
    if (role === 'assistant' && part?.type === 'redacted_thinking' && typeof part.data === 'string' && part.data) {
      return [{ type: 'redacted_thinking', data: part.data }];
    }
    if (role === 'user' && part?.type === 'image_url') {
      const url = part.image_url?.url;
      const match = typeof url === 'string' && /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(url);
      if (match) return [{ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }];
      throw invalid('MiniMax Code 网关的图片输入需要 base64 图片数据 URL');
    }
    throw invalid('MiniMax Code 网关收到不支持的消息内容块');
  });
}

function objectJson(value, label) {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw invalid(`MiniMax Code ${label}须为有效 JSON 对象`); }
  }
  if (!record(value)) throw invalid(`MiniMax Code ${label}须为 JSON 对象`);
  return value;
}

function nativeChoice(choice, tools) {
  if (choice == null || choice === 'auto') return undefined;
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required' || choice === 'any') return { type: 'any' };
  const name = choice?.function?.name ?? choice?.name;
  if (choice?.type === 'function' && typeof name === 'string' && tools.some((tool) => tool.name === name)) return { type: 'tool', name };
  throw invalid('MiniMax Code tool_choice 必须引用已声明的函数');
}

export function toMiniMaxCodeBody({ model, messages, tools, functions, toolChoice, temperature, maxTokens }) {
  const item = MODELS.find((entry) => entry.id === model);
  if (!item) throw invalid('MiniMax Code 不支持此模型');
  const limit = maxTokens == null ? 4096 : maxTokens;
  if (!Number.isInteger(limit) || limit <= 0 || limit > item.maxOutputTokens) throw invalid('MiniMax Code max_tokens 超出模型输出上限');
  if (temperature != null && !Number.isFinite(temperature)) throw invalid('MiniMax Code temperature 须为有限数值');
  const system = [], dialog = [], legacyCalls = new Map();
  const append = (role, blocks) => {
    if (!blocks.length) return;
    if (dialog.at(-1)?.role === role) dialog.at(-1).content.push(...blocks);
    else dialog.push({ role, content: blocks });
  };
  for (const [index, message] of (Array.isArray(messages) ? messages : []).entries()) {
    const role = message?.role;
    if (role === 'system' || role === 'developer') {
      system.push(...contentBlocks(message.content, role));
    } else if (role === 'user') {
      append('user', contentBlocks(message.content, role));
    } else if (role === 'assistant') {
      const content = contentBlocks(message.content, role);
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      const legacy = calls.length === 0 && record(message.function_call);
      const requested = legacy ? [{ id: `legacy_tool_${index}`, function: message.function_call }] : calls;
      for (const call of requested) {
        const fn = call?.function || call?.function_call;
        if (typeof call?.id !== 'string' || !call.id || typeof fn?.name !== 'string' || !fn.name) {
          throw invalid('MiniMax Code 工具历史缺少调用 ID 或函数名');
        }
        const input = objectJson(fn.arguments == null || fn.arguments === '' ? {} : fn.arguments, '工具参数');
        content.push({ type: 'tool_use', id: call.id, name: fn.name, input });
        if (legacy) legacyCalls.set(fn.name, call.id);
      }
      // Plain OpenAI reasoning_content does not include an authentic Messages
      // signature. Caller-supplied signed thinking blocks are retained above.
      append('assistant', content);
    } else if (role === 'tool' || role === 'function') {
      const id = message.tool_call_id || (role === 'function' ? legacyCalls.get(message.name) : null);
      if (typeof id !== 'string' || !id) throw invalid('MiniMax Code 工具结果缺少 tool_call_id');
      if (role === 'function') legacyCalls.delete(message.name);
      const content = typeof message.content === 'string' ? message.content : contentBlocks(message.content, 'user');
      append('user', [{ type: 'tool_result', tool_use_id: id, content }]);
    } else {
      throw invalid('MiniMax Code 网关收到不支持的消息角色');
    }
  }
  if (!dialog.length || dialog[0].role !== 'user') throw invalid('MiniMax Code 对话须从用户消息开始');
  const specs = Array.isArray(tools) && tools.length ? tools.map((tool) => {
    if (tool?.type !== 'function') throw invalid('MiniMax Code 支持 function 工具定义');
    return tool.function;
  }) : Array.isArray(functions) ? functions : [];
  const nativeTools = specs.map((fn) => {
    if (typeof fn?.name !== 'string' || !fn.name) throw invalid('MiniMax Code 工具定义缺少函数名');
    return { name: fn.name, ...(typeof fn.description === 'string' ? { description: fn.description } : {}),
      input_schema: objectJson(fn.parameters ?? { type: 'object', properties: {} }, '工具 schema') };
  });
  const selection = nativeTools.length ? nativeChoice(toolChoice, nativeTools) : undefined;
  return { model, stream: true, max_tokens: limit, messages: dialog, ...(system.length ? { system } : {}),
    ...(temperature != null ? { temperature } : {}), ...(nativeTools.length ? { tools: nativeTools } : {}),
    ...(selection ? { tool_choice: selection } : {}) };
}

function normalizeUsage(usage) {
  if (!Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
  const cached = usage.cache_read_input_tokens ?? 0;
  const prompt = usage.input_tokens + cached + (usage.cache_creation_input_tokens ?? 0);
  return { prompt_tokens: prompt, completion_tokens: usage.output_tokens, total_tokens: prompt + usage.output_tokens,
    ...(Object.hasOwn(usage, 'cache_read_input_tokens') ? { prompt_tokens_details: { cached_tokens: cached } } : {}),
    ...(Object.hasOwn(usage, 'reasoning_tokens') ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } } : {}) };
}

function responseError(status) {
  if (status === 401 || status === 403) return error('MiniMax Code 登录或模型权限不可用，请在客户端检查登录', 'minimax_code_auth', status, 'authentication_error');
  if (status === 402 || status === 429) return error(`MiniMax Code 额度不足或请求受限（HTTP ${status}）`, 'minimax_code_quota', status, 'rate_limit_error');
  return error(`MiniMax Code 上游请求失败（HTTP ${status}）`, 'minimax_code_http');
}

const FINISH_REASONS = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length',
  model_context_window_exceeded: 'length', refusal: 'content_filter' };

export function createMiniMaxCodeAdapter({ cfg = minimaxCodeConfig, loadAuth = getMiniMaxCodeAuth,
  hasAuth = hasMiniMaxCodeAuth, fetchImpl = (...args) => fetch(...args) } = {}) {
  const enabled = () => Boolean(cfg.enabled && BASES[cfg.region] && hasAuth(cfg));
  async function* stream(params) {
    params.signal?.throwIfAborted();
    const base = BASES[cfg.region];
    if (!cfg.enabled || !base) throw error('MiniMax Code 通道未启用', 'minimax_code_disabled', 503);
    const body = toMiniMaxCodeBody(params);
    const timeout = AbortSignal.timeout(cfg.timeoutMs), controller = new AbortController();
    const signal = AbortSignal.any([timeout, controller.signal, ...(params.signal ? [params.signal] : [])]);
    try {
      const auth = await loadAuth({ ...cfg, signal });
      signal.throwIfAborted();
      if (!auth || auth.region !== cfg.region) throw error('MiniMax Code 登录已失效，请打开同地区客户端并登录', 'minimax_code_auth', 401, 'authentication_error');
      const started = performance.now();
      const res = await fetchImpl(`${base}/messages`, { method: 'POST', redirect: 'error', signal,
        headers: { authorization: `Bearer ${auth.accessToken}`, 'anthropic-version': '2023-06-01',
          'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) });
      yield { timing: { upstream_headers_ms: performance.now() - started } };
      if (!res.ok) throw responseError(res.status);
      if (!res.body) throw error('MiniMax Code 未返回响应流', 'minimax_code_stream_missing');
      const usage = {}, calls = new Map();
      const mergeUsage = (snapshot) => {
        for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'reasoning_tokens']) {
          if (Number.isFinite(snapshot?.[key]) && snapshot[key] >= 0) usage[key] = snapshot[key];
        }
      };
      let upstreamReason;
      for await (const event of readJsonEvents(res.body)) {
        const kind = event?.type || event?.__event;
        if (kind === 'error' || event?.error || (Number.isFinite(event?.code) && event.code !== 0)) {
          const type = event?.error?.type;
          if (type === 'rate_limit_error' || type === 'overloaded_error') throw responseError(429);
          if (type === 'authentication_error' || type === 'permission_error') throw responseError(401);
          throw error('MiniMax Code 上游返回错误', 'minimax_code_upstream_error');
        }
        if (kind === 'message_start') mergeUsage(event.message?.usage);
        if (kind === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'text' && typeof block.text === 'string' && block.text) yield { text: block.text };
          if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) yield { reasoning: block.thinking };
          if (block?.type === 'tool_use') {
            if (!Number.isInteger(event.index) || event.index < 0 || typeof block.id !== 'string' || !block.id
              || typeof block.name !== 'string' || !block.name || calls.has(event.index)) {
              throw error('MiniMax Code 返回不完整的工具调用', 'upstream_incomplete_tool_call');
            }
            // Messages indexes all content blocks. OpenAI indexes only calls.
            const index = calls.size;
            calls.set(event.index, { index, input: block.input, fragments: [], ended: false });
            yield { toolCall: { index, id: block.id, name: block.name, arguments: '' } };
          }
        }
        if (kind === 'content_block_delta') {
          const delta = event.delta;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) yield { text: delta.text };
          if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) yield { reasoning: delta.thinking };
          if (delta?.type === 'input_json_delta') {
            const call = calls.get(event.index);
            if (!call || call.ended || typeof delta.partial_json !== 'string') throw error('MiniMax Code 返回不完整的工具参数', 'upstream_incomplete_tool_call');
            if (delta.partial_json) {
              call.fragments.push(delta.partial_json);
              yield { toolCall: { index: call.index, arguments: delta.partial_json } };
            }
          }
        }
        if (kind === 'content_block_stop' && calls.has(event.index)) {
          const call = calls.get(event.index);
          if (!call.ended) {
            let input = call.input;
            if (call.fragments.length) {
              try { input = JSON.parse(call.fragments.join('')); } catch { input = null; }
            }
            if (!record(input)) throw error('MiniMax Code 工具参数须为完整 JSON 对象', 'upstream_incomplete_tool_call');
            if (!call.fragments.length) yield { toolCall: { index: call.index, arguments: JSON.stringify(input) } };
            call.fragments.length = 0;
          }
          call.ended = true;
        }
        if (kind === 'message_delta') {
          mergeUsage(event.usage);
          if (typeof event.delta?.stop_reason === 'string') upstreamReason = event.delta.stop_reason;
        }
        if (kind === 'message_stop') {
          if ([...calls.values()].some((call) => !call.ended)) throw error('MiniMax Code 工具调用在参数完成前结束', 'upstream_incomplete_tool_call');
          if (!Object.hasOwn(FINISH_REASONS, upstreamReason)) throw error('MiniMax Code 未返回可识别的结束原因', 'minimax_code_stop_reason');
          if (upstreamReason === 'tool_use' && !calls.size) throw error('MiniMax Code 未返回完整工具调用', 'upstream_incomplete_tool_call');
          const normalized = normalizeUsage(usage);
          if (normalized) yield { usage: normalized };
          yield { done: true, upstreamFinishReason: upstreamReason, finishReason: FINISH_REASONS[upstreamReason], terminationReason: 'upstream_done' };
          return;
        }
      }
      throw error('MiniMax Code 响应流提前中断', 'minimax_code_stream_eof');
    } catch (cause) {
      params.signal?.throwIfAborted();
      if (timeout.aborted) throw error('MiniMax Code 上游请求超时', 'minimax_code_timeout', 504);
      if (cause?.status) throw cause;
      throw error('MiniMax Code 上游连接中断', 'minimax_code_connection');
    } finally {
      controller.abort();
    }
  }
  return { name: 'minimax-code', enabled, models: () => MODELS, stream, supportsTools: true };
}

export const minimaxCodeAdapter = createMiniMaxCodeAdapter();
