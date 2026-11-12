import { randomBytes, randomUUID } from 'node:crypto';
import { doubaoConfig, readDoubaoModels } from '../doubao-config.js';
import { hasDoubaoAuth } from '../doubao-auth.js';
import { createDoubaoClient } from '../doubao-client.js';
import { createDoubaoAccount } from '../doubao-account.js';
import { decodeDoubaoStream } from '../doubao-stream.js';
import { readJsonEvents } from '../sse.js';
import { toQoderPrompt } from './qoder.js';
import { toolsToPromptText, toolNames, ToolMarkupSieve } from '../toolcall.js';

const failure = (message, code, status = 502) => Object.assign(new Error(message), {
  code, status, type: status < 500 ? 'invalid_request_error' : 'upstream_error',
});

/** Match the shipped desktop request while keeping tool execution in the API caller. */
export function doubaoChatRequest(prompt, model, now = Date.now()) {
  const localId = 'local_' + [...randomBytes(16)].map((byte) => byte % 10).join('');
  const reasoning = model.reasoningEffort;
  return {
    client_meta: { local_conversation_id: localId, conversation_id: '',
      bot_id: '7338286299411103781', last_section_id: '', last_message_index: null, local_permissions: [] },
    messages: [{ local_message_id: randomUUID(), message_status: 1, content_block: [{
      block_type: 10000, block_id: randomUUID(), parent_id: '', meta_info: [], extra_info: {},
      content: { text_block: { text: prompt, icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
    }] }],
    option: {
      need_create_conversation: true, create_time_ms: now, unique_key: randomUUID(),
      conversation_mode: 1, agent_mode: model.agentMode,
      model_config: { model_item_key: model.modelItemKey,
        model_extra_params: model.modelExtraParams || {}, reasoning_effort: reasoning },
      aggregate_params: { conversation_mode: '1', mode_id: model.modeId,
        model_item_key: model.modelItemKey, agent_mode: String(model.agentMode),
        reasoning_effort: String(reasoning), provider_id: '' },
      conversation_init_ext: { model_item_key: model.modelItemKey, mode_id: model.modeId,
        reasoning_effort: String(reasoning) },
      scene_type: 0, message_from: 0, need_deep_think: 0, message_storage_type: 0,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
      sse_recv_event_options: { support_chunk_delta: false },
    },
    user_context: [], ext: { conversation_mode: 'chat' },
  };
}

export function createDoubaoAdapter({ cfg = doubaoConfig, client = createDoubaoClient({ cfg }),
  getModels = () => readDoubaoModels(cfg), hasAuth = hasDoubaoAuth } = {}) {
  const account = createDoubaoAccount({ request: client.request, getAuth: client.getAuth });
  async function* stream({ model, messages, tools, functions, toolChoice, signal }) {
    signal?.throwIfAborted();
    const selected = getModels().find((item) => item.id === model);
    if (!selected) throw failure('豆包模型不可用，请从模型列表重新选择', 'doubao_unknown_model', 404);
    if (messages.some((message) => Array.isArray(message.content)
      && message.content.some((part) => part?.type !== 'text'))) {
      throw failure('豆包当前转发通道支持文本消息和工具结果', 'doubao_unsupported_content', 400);
    }
    const names = toolChoice === 'none' ? [] : toolNames(tools, functions);
    const forced = typeof toolChoice === 'object' && toolChoice?.function?.name;
    const requiresTool = Boolean(forced) || toolChoice === 'required' || toolChoice === 'any';
    if (requiresTool && (!names.length || forced && !names.includes(forced))) {
      throw failure('豆包 tool_choice 必须引用已声明的工具', 'doubao_invalid_tool_choice', 400);
    }
    const definitions = toolsToPromptText(tools, functions, toolChoice, { format: 'json' });
    const instructions = definitions ? definitions + '\n工具由外部 API 调用方执行。'
      + '当前豆包客户端是转发通道。项目路径和执行环境以传入会话及真实工具结果为准。'
      + '输出本轮工具请求后结束，等待下一轮外部结果。' : '';
    // Reuse the existing text-transport serializer for system, reasoning and ID-matched results.
    const prompt = toQoderPrompt(messages, { toolPrompt: instructions });
    // 豆包是转发通道：客户端没声明工具时正文里的标记按普通文本保留
    const sieve = new ToolMarkupSieve({ allowedNames: forced ? [forced] : names, tools, functions });
    const exchange = await client.openStream('/chat/completion', doubaoChatRequest(prompt, selected), signal);
    const { response } = exchange;
    let toolIndex = 0;
    function* filtered(part) {
      if (part.text) yield { text: part.text };
      for (const call of part.calls) {
        yield { toolCall: { index: toolIndex++, id: call.id, name: call.name, arguments: call.arguments } };
      }
    }
    try {
      if (!response.headers.get('content-type')?.includes('text/event-stream')) {
        throw failure('豆包聊天接口未返回 SSE', 'doubao_invalid_response');
      }
      for await (const event of decodeDoubaoStream(readJsonEvents(response.body, { includeId: true }), {
        signal: exchange.signal,
      })) {
        if (event.text) yield* filtered(sieve.push(event.text));
        if (sieve.stopped) {
          yield { done: true, finishReason: 'tool_calls', terminationReason: 'tool_turn_boundary' };
          return;
        }
        if (event.done) {
          yield* filtered(sieve.flush());
          if (requiresTool && !toolIndex) throw failure('豆包未返回本轮要求的工具调用', 'upstream_missing_tool_call');
          yield { ...event, finishReason: toolIndex ? 'tool_calls' : event.finishReason };
        } else if (!event.text) yield event;
      }
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
  return { name: 'doubao', supportsTools: false,
    enabled: () => cfg.enabled && hasAuth(cfg) && getModels().length > 0,
    models: getModels, stream, quota: account.quota, checkin: account.checkin };
}

export const doubaoAdapter = createDoubaoAdapter();
