import { config } from '../config.js';
import { readJsonEvents, SSE_DONE } from '../sse.js';

/**
 * 通用 OpenAI 兼容上游转发。
 * 火山方舟 / 智谱 / DeepSeek / 月之暗面 / MiniMax / 通义 都是这个协议，
 * 只要换 UPSTREAM_BASE 和 UPSTREAM_KEY 就能切厂商。
 */
export async function* streamOpenAI({ model, messages, temperature, maxTokens, signal, tools, functions, toolChoice }) {
  const base = (config.upstream.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 UPSTREAM_BASE');
  if (!config.upstream.apiKey) throw new Error('未配置 UPSTREAM_KEY，请在 .env 或环境变量里填入上游密钥');

  const url = `${base}/chat/completions`;
  const toolList = Array.isArray(tools) ? tools : [];
  const fnList = Array.isArray(functions) ? functions : [];
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.upstream.apiKey}`,
      ...config.upstream.headers,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(temperature != null ? { temperature } : {}),
      ...(maxTokens != null ? { max_tokens: maxTokens } : {}),
      // 这家本来就是 OpenAI 协议，工具直接透传
      ...(toolList.length || fnList.length ? { tools: [...toolList, ...fnList.map((fn) => ({ type: 'function', function: fn }))] } : {}),
      ...(toolChoice != null ? { tool_choice: toolChoice } : {}),
    }),
    signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`上游 ${res.status} ${body.slice(0, 300) || res.statusText}`);
  }
  if (!res.body) throw new Error('上游没有返回响应体');

  let finishReason, doneMarker = false;
  for await (const event of readJsonEvents(res.body, { includeDone: true })) {
    if (event === SSE_DONE) { doneMarker = true; break; }
    if (event?.error) throw new Error(event.error.message || '上游返回错误');
    const choice = event?.choices?.[0];
    const d = choice?.delta;
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    if (event?.usage) yield { usage: event.usage };
    if (!d) continue;
    const reasoning = d.reasoning_content || d.reasoning;
    if (typeof reasoning === 'string' && reasoning) yield { reasoning };
    if (typeof d.content === 'string' && d.content) yield { text: d.content };
    const calls = Array.isArray(d.tool_calls) ? d.tool_calls : d.function_call ? [{ function: d.function_call }] : [];
    for (const tc of calls) {
      const fn = tc.function || {};
      yield { toolCall: { index: Number.isInteger(tc.index) ? tc.index : 0, id: tc.id || '', type: tc.type || 'function',
        name: fn.name || '', arguments: typeof fn.arguments === 'string' ? fn.arguments : '' } };
    }
  }
  if (!doneMarker && !finishReason) throw Object.assign(new Error('上游连接提前结束，未收到终止帧'), { code: 'upstream_stream_eof' });
  yield { done: true, upstreamFinishReason: finishReason, terminationReason: 'upstream_done' };
}

export const openaiAdapter = {
  name: 'openai',
  models: () => config.models,
  stream: streamOpenAI,
  supportsTools: true,
};
