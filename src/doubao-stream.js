/** Doubao 2.34.6 named SSE, from packaged modules 996739/899248/670958.
 * ContentBlock=1; append/replace/delete=1/2/3; ReplyFinish=3.
 * Thinking blocks (10040) contain titles. Their descendant text blocks (10000)
 * carry reasoning. Unknown UI blocks are kept only to resolve this ancestry.
 */
const CONTENT_BLOCK = 1;
const APPEND = 1;
const REPLACE = 2;
const DELETE = 3;
const TEXT = 10000;
const THINKING = 10040;
const KNOWN_EVENTS = new Set(['FULL_MSG_NOTIFY', 'STREAM_MSG_NOTIFY', 'STREAM_CHUNK',
  'CHUNK_DELTA', 'SSE_REPLY_END', 'STREAM_ERROR', 'gateway-error']);

function failure(message, code = 'doubao_stream_protocol') {
  return Object.assign(new Error(message), { code, status: 502, type: 'upstream_error' });
}

function payloadOf(frame) {
  const raw = typeof frame.event === 'string' && Object.hasOwn(frame, 'data') ? frame.data : frame;
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch {
    throw failure('豆包流式事件包含不完整的 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('豆包流式事件格式无效');
  return data;
}

function identifier(value) {
  if (typeof value === 'string' && value) return value;
  if (Number.isSafeInteger(value)) return String(value);
  throw failure('豆包流式消息缺少有效 ID');
}

function sequence(value) {
  if (value == null || value === '') return null;
  if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^\d{1,30}$/.test(value)) return BigInt(value);
  throw failure('豆包流式序号无效');
}

function blockFrom(record, previous, append = false) {
  if (!record || typeof record !== 'object') throw failure('豆包内容块格式无效');
  const id = identifier(record.block_id);
  const type = Number(record.block_type);
  if (!Number.isSafeInteger(type) || type <= 0) throw failure('豆包内容块类型无效');
  const incoming = type === TEXT ? record.content?.text_block?.text : undefined;
  if (incoming != null && typeof incoming !== 'string') throw failure('豆包文本内容格式无效');
  if (append && previous) {
    if (type !== previous.type) throw failure('豆包追加内容的块类型发生变化');
    if (incoming) {
      previous.chunks.push(incoming);
      previous.pending.push(incoming);
      previous.length += incoming.length;
    }
    return previous;
  }
  const text = incoming ?? '';
  const sentLength = previous?.sentLength || 0;
  if (sentLength && !text.startsWith(previous.chunks.join('').slice(0, sentLength))) {
    throw failure('豆包修改了已经输出的内容，请重试本轮', 'doubao_stream_rewrite');
  }
  return { id, type, parentId: record.parent_id == null ? '' : String(record.parent_id),
    chunks: text ? [text] : [], length: text.length, sentLength,
    sentChannel: previous?.sentChannel, pending: text.length > sentLength ? [text.slice(sentLength)] : [] };
}

function channelOf(block, blocks) {
  let parent = block.parentId;
  let channel = 'text';
  const visited = new Set([block.id]);
  while (parent && parent !== '0') {
    if (visited.has(parent)) throw failure('豆包内容块存在循环引用');
    visited.add(parent);
    const ancestor = blocks.get(parent);
    if (!ancestor) return null;
    if (ancestor.type === THINKING) channel = 'reasoning';
    parent = ancestor.parentId;
  }
  return channel;
}

export class DoubaoStreamDecoder {
  constructor() {
    this.messages = new Map();
    this.ignoredMessages = new Set();
    this.outputOrder = { text: [], reasoning: [] };
    this.latestDelta = null;
    this.done = false;
    this.error = null;
  }

  snapshot(messageId, userType, blocks) {
    const id = identifier(messageId);
    if (Number(userType) === 1 || Number(userType) === 3) {
      this.ignoredMessages.add(id);
      return;
    }
    if (this.ignoredMessages.has(id)) return;
    const message = this.messages.get(id) || { blocks: new Map(), lastSequence: null };
    if (blocks !== undefined) {
      if (!Array.isArray(blocks)) throw failure('豆包消息内容块格式无效');
      const next = new Map();
      for (const record of blocks) {
        const block = blockFrom(record, message.blocks.get(identifier(record?.block_id)));
        if (next.has(block.id)) throw failure('豆包消息包含重复的内容块 ID');
        next.set(block.id, block);
      }
      message.blocks = next;
    }
    this.messages.set(id, message);
  }

  acceptSequence(message, value) {
    const next = sequence(value);
    if (next === null) return true;
    if (message.lastSequence !== null && next <= message.lastSequence) return false;
    message.lastSequence = next;
    return true;
  }

  patchBlocks(message, patch) {
    const type = Number(patch.patch_type);
    const records = patch.patch_value?.content_block;
    if (type === DELETE) { message.blocks = new Map(); return; }
    if (!Array.isArray(records)) throw failure('豆包内容补丁缺少内容块');
    if (type === REPLACE) {
      const next = new Map();
      for (const record of records) {
        const block = blockFrom(record, message.blocks.get(identifier(record?.block_id)));
        if (next.has(block.id)) throw failure('豆包补丁包含重复的内容块 ID');
        next.set(block.id, block);
      }
      message.blocks = next;
      return;
    }
    if (type !== APPEND) throw failure('豆包内容补丁类型不受支持');
    for (const record of records) {
      const innerType = Number(record.patch_type);
      // The shipped client skips block patches without a nonzero inner type.
      if (!innerType) continue;
      const id = identifier(record.block_id);
      if (innerType === DELETE) { message.blocks.delete(id); continue; }
      if (innerType !== APPEND && innerType !== REPLACE) throw failure('豆包内容块补丁类型不受支持');
      message.blocks.set(id, blockFrom(record, message.blocks.get(id), innerType === APPEND));
    }
  }

  chunk(data, frameId) {
    const messageId = identifier(data.message_id);
    if (!Array.isArray(data.patch_op)) throw failure('豆包流式事件缺少补丁数组');
    const candidate = data.patch_op.length === 1 && Number(data.patch_op[0].patch_object) === CONTENT_BLOCK
      ? data.patch_op[0].patch_value?.content_block : null;
    if (candidate?.length === 1) {
      const block = candidate[0];
      this.latestDelta = { messageId, block, contentKey: Object.keys(block.content || {})[0] };
    }
    const message = this.messages.get(messageId);
    if (!message || this.ignoredMessages.has(messageId) || !this.acceptSequence(message, data.seq_no ?? frameId)) return;
    for (const patch of data.patch_op) {
      if (Number(patch.patch_object) === CONTENT_BLOCK) this.patchBlocks(message, patch);
    }
  }

  delta(data, frameId) {
    const latest = this.latestDelta;
    if (!latest?.contentKey) throw failure('豆包增量缺少对应的内容块');
    const message = this.messages.get(latest.messageId);
    if (!message || this.ignoredMessages.has(latest.messageId) || !this.acceptSequence(message, frameId)) return;
    this.patchBlocks(message, { patch_type: APPEND, patch_value: { content_block: [{
      block_id: latest.block.block_id, block_type: latest.block.block_type,
      parent_id: latest.block.parent_id, content: { [latest.contentKey]: data }, patch_type: APPEND,
    }] } });
  }

  drain(terminal = false) {
    const visible = [];
    const order = { text: [], reasoning: [] };
    for (const [messageId, message] of this.messages) {
      for (const block of message.blocks.values()) {
        if (block.type !== TEXT || !block.length) continue;
        const channel = channelOf(block, message.blocks);
        if (!channel) {
          if (terminal) throw failure('豆包流结束时仍缺少父内容块');
          continue;
        }
        if (block.sentLength && channel !== block.sentChannel) throw failure('豆包修改了已经输出的内容类型', 'doubao_stream_rewrite');
        const key = JSON.stringify([messageId, block.id]);
        order[channel].push(key);
        visible.push({ block, channel, index: order[channel].length - 1 });
      }
    }
    for (const channel of ['text', 'reasoning']) {
      if (!this.outputOrder[channel].every((key, index) => order[channel][index] === key)) {
        throw failure('豆包删除或重排了已经输出的内容', 'doubao_stream_rewrite');
      }
    }
    const events = [];
    for (const { block, channel, index } of visible) {
      if (!block.pending.length) continue;
      if (index < this.outputOrder[channel].length - 1) throw failure('豆包修改了先前的内容块', 'doubao_stream_rewrite');
      events.push({ [channel]: block.pending.join('') });
      block.pending = [];
      block.sentLength = block.length;
      block.sentChannel = channel;
    }
    this.outputOrder = order;
    return events;
  }

  push(frame) {
    if (this.error) throw this.error;
    if (this.done) return [];
    const name = frame?.__event || frame?.event;
    if (!KNOWN_EVENTS.has(name)) return [];
    try {
      if (name === 'gateway-error') throw failure('豆包网关返回了流式错误', 'doubao_stream_error');
      const data = payloadOf(frame);
      const frameId = frame.__id ?? frame.id;
      switch (name) {
        case 'FULL_MSG_NOTIFY':
          if (!data.message) throw failure('豆包完整消息缺少消息对象');
          this.snapshot(data.message.message_id, data.message.user_type, data.message.content_block);
          break;
        case 'STREAM_MSG_NOTIFY':
          if (!data.meta || !data.content) throw failure('豆包流式消息缺少元数据');
          this.snapshot(data.meta.message_id, data.meta.user_type, data.content.content_block);
          break;
        case 'STREAM_CHUNK': this.chunk(data, frameId); break;
        case 'CHUNK_DELTA': this.delta(data, frameId); break;
        case 'STREAM_ERROR': {
          const code = Number.isSafeInteger(data.error_code) ? `（${data.error_code}）` : '';
          throw failure(`豆包上游返回流式错误${code}`, 'doubao_stream_error');
        }
        case 'SSE_REPLY_END':
          if (Number(data.end_type) === 3) {
            const events = this.drain(true);
            this.done = true;
            return [...events, { done: true, finishReason: 'stop', upstreamFinishReason: 'stop', terminationReason: 'upstream_done' }];
          }
          break;
      }
      return this.drain();
    } catch (error) {
      this.error = error;
      throw error;
    }
  }

  finish() {
    if (this.error) throw this.error;
    if (!this.done) throw Object.assign(failure('豆包流在完成标记前结束，请重试本轮', 'doubao_stream_incomplete'), { terminationReason: 'upstream_eof' });
  }
}

export async function* decodeDoubaoStream(events, { signal } = {}) {
  const decoder = new DoubaoStreamDecoder();
  signal?.throwIfAborted();
  for await (const frame of events) {
    signal?.throwIfAborted();
    for (const event of decoder.push(frame)) yield event;
    if (decoder.done) return;
  }
  signal?.throwIfAborted();
  decoder.finish();
}
