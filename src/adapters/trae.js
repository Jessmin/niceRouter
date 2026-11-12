import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { readJsonEvents } from '../sse.js';
import { traeQuota, traeCheckin } from '../quota.js';
import { formatReasoningHistory, toolNames, toolsToPromptText, ToolMarkupSieve } from '../toolcall.js';

/**
 * Trae CN 真实链路适配器
 * ------------------------------------------------------------------
 * 端点：POST /api/ide/v1/chat            （明文 JSON，非加密；加密的是 /api/agent/v3/*）
 * 鉴权：Authorization: Cloud-IDE-JWT <token>  +  x-ide-token: <同一个 token>
 * 必填：model_name（服务端 model_list?type=chat 返回的 name）、intent_name
 * 事件：event: output      -> {response, reasoning_content}
 *       event: token_usage -> {prompt_tokens, completion_tokens, ...}
 *       event: error       -> {code, message}
 *       event: done        -> {finish_reason}
 * 坑：variables:{}/valid_turns:1 会被网关判 400，所以只发下面这几个字段。
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

/**
 * OpenAI messages -> Trae 的 {user_input, chat_history}
 * ------------------------------------------------------------------
 * 这个通道（/api/ide/v1/chat，general_qa_intent）**不认 tools 字段**
 * （实测：传了也 200，但 tool_calls 恒为 null），
 * 所以工具只能退化成文本协议：把函数清单写进 user_input，靠 ToolMarkupSieve 还原。
 */
export function splitMessages(messages, toolPrompt = '') {
  const list = Array.isArray(messages) ? messages : [];
  const systems = list.filter((m) => m.role === 'system' || m.role === 'developer');
  const dialog = list.filter((m) => m.role !== 'system' && m.role !== 'developer');

  // A Harness step can append runtime context after the user's task, or
  // contain several tool results after the last assistant turn. Trae has
  // one current user_input, so keep that whole trailing input together.
  const isResult = (m) => m?.role === 'tool' || m?.role === 'function';
  const isRuntimeContext = (m) => {
    if (m?.role !== 'user') return false;
    const text = textOf(m.content);
    return text.startsWith('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n')
      || text === 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';
  };
  let inputStart = Math.max(0, dialog.length - 1);
  if (dialog[inputStart]?.role === 'user') {
    while (inputStart > 0 && dialog[inputStart - 1]?.role === 'user') inputStart--;
    if (dialog.slice(inputStart).every(isRuntimeContext)) {
      while (inputStart > 0 && isResult(dialog[inputStart - 1])) inputStart--;
    }
  } else if (isResult(dialog[inputStart])) {
    while (inputStart > 0 && isResult(dialog[inputStart - 1])) inputStart--;
  }
  const history = dialog.slice(0, inputStart);

  const callNames = new Map();
  const callText = (c) => {
    const fn = c.function || c.function_call || {};
    if (c.id != null) callNames.set(c.id, fn.name || '');
    let args = fn.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* Preserve non-JSON arguments as text. */ }
    }
    const data = { ...(c.id != null ? { id: c.id } : {}), name: fn.name || '', arguments: args === undefined ? {} : args };
    return `<tool_call>${JSON.stringify(data).replace(/</g, '\\u003c')}</tool_call>`;
  };
  const messageText = (m) => {
    const text = textOf(m?.content);
    if (m?.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      const historyCalls = calls.length || !m.function_call?.name ? calls : [{ function_call: m.function_call }];
      return [formatReasoningHistory(m), text, ...historyCalls.map(callText)].filter(Boolean).join('\n');
    }
    if (m?.role === 'tool' || m?.role === 'function') {
      const name = m.name || callNames.get(m.tool_call_id);
      const labels = [name ? `name=${JSON.stringify(name)}` : '', m.tool_call_id != null ? `id=${JSON.stringify(m.tool_call_id)}` : ''].filter(Boolean).join(' ');
      return `[工具结果${labels ? ` ${labels}` : ''}]\n${text}`;
    }
    return text;
  };
  const chatHistory = history.map((m) => {
    if (m.role === 'user') return { role: 'user', content: textOf(m.content) };
    if (m.role === 'assistant') return { role: 'assistant', content: messageText(m) };
    if (m.role === 'tool' || m.role === 'function') return { role: 'user', content: messageText(m) };
    return null;
  }).filter(Boolean);
  let userInput = dialog.slice(inputStart).map(messageText).join('\n\n');
  const head = [...systems.map((m) => textOf(m.content)).filter(Boolean), toolPrompt]
    .filter(Boolean)
    .join('\n\n');
  if (head) userInput = `[系统设定]\n${head}\n\n[用户]\n${userInput}`;

  return {
    user_input: userInput,
    chat_history: chatHistory,
  };
}

function buildBody({ model, messages, tools, functions, toolChoice }) {
  const toolPrompt = toolChoice === 'none' ? '本轮请直接用正文回答，不调用工具。' : toolsToPromptText(tools, functions, toolChoice);
  return {
    ...splitMessages(messages, toolPrompt),
    model_name: model,
    intent_name: config.trae.intent,
    session_id: '',
    conversation_id: '',
    generate_suggested_questions: false,
  };
}

function saveCapture(request, rawResponse, status) {
  if (!config.trae.capture) return;
  const dir = join(config.rootDir, 'captures');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(
    join(dir, `${stamp}.json`),
    JSON.stringify({ status, request, rawResponse: rawResponse.slice(0, 200000) }, null, 2),
    'utf8',
  );
}

export function traeModelNames() {
  // 返回对象数组（含 display/context），server.js 聚合时要用
  return config.models;
}

/** 用当前凭据实时拉一次服务端模型清单（失败返回 null） */
export async function fetchTraeModels() {
  const cfg = config.trae;
  if (!cfg.token) return null;
  try {
    const res = await fetch(cfg.base + cfg.modelListPath, {
      method: 'GET',
      headers: { ...cfg.headers, 'accept-encoding': 'identity' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return (j.model_configs || []).map((m) => ({
      id: m.name,
      display: m.display_name || m.name,
      type: m.model_type === 'reasoning_model' ? 'reasoning' : 'chat',
    }));
  } catch {
    return null;
  }
}

export async function* streamTrae({ model, messages, signal, tools, functions, toolChoice }) {
  const cfg = config.trae;
  if (!cfg.token) {
    throw new Error('缺少 token：请在 config/trae-session.json 的 headers.authorization 里填入 Cloud-IDE-JWT <token>');
  }

  const names = toolNames(tools, functions);
  const forcedName = toolChoice?.function?.name;
  if (forcedName && !names.includes(forcedName)) {
    throw Object.assign(new Error('Trae tool_choice 必须引用已声明的函数'), {
      status: 400, type: 'invalid_request_error', code: 'trae_invalid_tool_choice',
    });
  }
  // 客户端没声明任何工具时仍解析正文里的标记（恢复轮模型可能照样发起调用），
  // 只有显式 toolChoice=none 才完全不接文本协议。
  const allowedNames = toolChoice === 'none' ? [] : forcedName ? [forcedName] : (names.length ? names : null);
  const body = buildBody({ model, messages, tools, functions, toolChoice });
  const url = cfg.base.replace(/\/$/, '') + cfg.chatPath;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
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
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    throw error;
  }

  if (!res.ok) {
    try {
      const errText = await res.text().catch(() => '');
      saveCapture(body, errText, res.status);
      throw new Error(`Trae 上游 ${res.status} ${res.statusText}: ${errText.slice(0, 600)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  let raw = '';
  let finished = false;
  let toolBoundary = false;
  const sieve = new ToolMarkupSieve({ allowedNames, tools, functions });
  let fallbackIdx = 0;

  try {
    yield { timing: { upstream_headers_ms: performance.now() - fetchStarted } };
    for await (const evt of readJsonEvents(res.body)) {
      const name = evt.__event || '';
      raw += JSON.stringify(evt) + '\n';

      // 错误事件：{code, message}
      if (name === 'error' || (typeof evt.code === 'number' && evt.code >= 3000)) {
        const msg = evt.message || evt.error || `上游错误码 ${evt.code}`;
        throw new Error(`Trae 上游拒绝：${msg}`);
      }

      if (name === 'output') {
        if (typeof evt.reasoning_content === 'string' && evt.reasoning_content) {
          yield { reasoning: evt.reasoning_content };
        }
        if (typeof evt.response === 'string' && evt.response) {
          const { text, calls } = sieve.push(evt.response);
          if (text) yield { text };
          for (const c of calls) {
            yield { toolCall: { index: fallbackIdx++, id: c.id, name: c.name, arguments: c.arguments } };
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
        const usage = {
          prompt_tokens: evt.prompt_tokens || 0,
          completion_tokens: evt.completion_tokens || 0,
          total_tokens: evt.total_tokens || (evt.prompt_tokens || 0) + (evt.completion_tokens || 0),
        };
        if (usage.total_tokens) yield { usage };
        continue;
      }

      if (name === 'done') {
        finished = true;
        const tail = sieve.flush();
        if (tail.text) yield { text: tail.text };
        for (const c of tail.calls) yield { toolCall: { index: fallbackIdx++, id: c.id, name: c.name, arguments: c.arguments } };
        yield { done: true, finishReason: evt.finish_reason, upstreamFinishReason: evt.finish_reason, terminationReason: 'upstream_done' };
        return;
      }
    }
    if (!finished) throw new Error('Trae 上游连接提前结束，未收到 done（请重试或检查超时）');
  } finally {
    if (toolBoundary) controller.abort();
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    saveCapture(body, raw, res.status);
  }
}

export const traeAdapter = {
  name: 'trae',
  models: traeModelNames,
  stream: streamTrae,
  quota: traeQuota,
  checkin: traeCheckin,
  // 这条通道不认原生 tools，工具走文本协议（toolsToPromptText + 标记筛子）
  supportsTools: false,
};
