/**
 * Tolerant SSE / NDJSON reader.
 * Trae's upstream does not use OpenAI's event shape, so we parse whatever JSON
 * objects arrive and let `extractDelta` decide what they mean.
 */

/**
 * Trae's stream is `id:N` / `event:<name>` / `data:{...}`. We keep the event
 * name on the parsed object as `__event` so callers can tell `progress_notice`
 * apart from `output` (both carry a human string field).
 */
export const SSE_DONE = Symbol('SSE [DONE]');

export async function* readJsonEvents(body, { includeDone = false, includeId = false } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingEvent = '';
  let pendingId = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    // Events are separated by blank lines (SSE) or newlines (NDJSON).
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);

      const line = rawLine.trim();
      if (!line) {
        pendingEvent = '';
        pendingId = '';
        continue;
      }
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        pendingEvent = line.slice(6).trim();
        continue;
      }
      if (line.startsWith('id:')) {
        pendingId = line.slice(3).trim();
        continue;
      }

      const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (!payload) continue;
      if (payload === '[DONE]') {
        if (includeDone) yield SSE_DONE;
        continue;
      }

      try {
        const parsed = JSON.parse(payload);
        if (parsed && typeof parsed === 'object' && pendingEvent && !parsed.__event) {
          Object.defineProperty(parsed, '__event', {
            value: pendingEvent,
            enumerable: false,
            configurable: true,
          });
        }
        if (includeId && parsed && typeof parsed === 'object' && pendingId) {
          Object.defineProperty(parsed, '__id', { value: pendingId, enumerable: false });
        }
        yield parsed;
      } catch {
        // Non-JSON keep-alive or partial frame; ignore.
      }
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const payload = tail.startsWith('data:') ? tail.slice(5).trim() : tail;
    if (payload === '[DONE]' && includeDone) yield SSE_DONE;
    if (payload && payload !== '[DONE]') {
      try {
        const parsed = JSON.parse(payload);
        if (parsed && typeof parsed === 'object' && pendingEvent && !parsed.__event) {
          Object.defineProperty(parsed, '__event', { value: pendingEvent, enumerable: false });
        }
        if (includeId && parsed && typeof parsed === 'object' && pendingId) {
          Object.defineProperty(parsed, '__id', { value: pendingId, enumerable: false });
        }
        yield parsed;
      } catch {
        /* ignore */
      }
    }
  }
}

const TEXT_PATHS = [
  ['delta', 'content'],
  ['delta', 'text'],
  ['content'],
  ['text'],
  ['message', 'content'],
  ['event_data', 'content'],
  ['event_data', 'delta'],
  ['data', 'content'],
  ['data', 'delta'],
  ['choices', 0, 'delta', 'content'],
  ['choices', 0, 'text'],
  ['result', 'content'],
];

const REASONING_PATHS = [
  ['delta', 'reasoning_content'],
  ['reasoning_content'],
  ['delta', 'reasoning'],
  ['reasoning'],
  ['data', 'reasoning_content'],
];

const DONE_FLAGS = ['done', 'is_done', 'finished', 'is_finished', 'eos', 'is_end'];

function pick(obj, path) {
  let cur = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Map one upstream event onto a normalized delta.
 * @returns {{text?: string, reasoning?: string, done?: boolean, usage?: object}}
 */
export function extractDelta(event) {
  const out = {};

  for (const p of TEXT_PATHS) {
    const v = pick(event, p);
    if (typeof v === 'string' && v.length > 0) {
      out.text = v;
      break;
    }
  }
  for (const p of REASONING_PATHS) {
    const v = pick(event, p);
    if (typeof v === 'string' && v.length > 0) {
      out.reasoning = v;
      break;
    }
  }

  if (event && typeof event === 'object') {
    for (const f of DONE_FLAGS) {
      if (event[f] === true) {
        out.done = true;
        break;
      }
    }
    if (event.usage && typeof event.usage === 'object') out.usage = event.usage;
    // Trae wraps stream chunks in an envelope with a numeric event type.
    if (event.event === 'done' || event.type === 'done' || event.type === 'finish') out.done = true;
  }

  return out;
}
