/** Incremental JSON/tool-marker framing. Parses data only; never evaluates it. */
const DEFAULT_LIMIT = 8 * 1024 * 1024;
const ARGUMENT_KEYS = ['arguments', 'parameters', 'args', 'input'];
const TAG_NAMES = ['tool_call', 'tool_calls', 'call_call', 'call_calls',
  'tool-call', 'tool-calls', 'call_tool', 'call_tools', 'call-tool', 'call-tools'];
const TAG_PREFIXES = [
  ...TAG_NAMES.flatMap((name) => [`<${name}`, `</${name}`, `<seed:${name}`, `</seed:${name}`]),
  '</|tool_call',
];
const SPACE = /\s/u;

class Fragments {
  constructor() { this.blocks = []; this.tail = ''; this.length = 0; }
  append(text) {
    if (!text) return;
    this.length += text.length;
    if (this.tail.length + text.length > 8192) {
      if (this.tail) this.blocks.push(this.tail);
      this.tail = '';
      if (text.length > 8192) { this.blocks.push(text); return; }
    }
    this.tail += text;
  }
  text() { return this.blocks.length ? this.blocks.join('') + this.tail : this.tail; }
}

class Parts {
  constructor() { this.parts = []; this.text = new Fragments(); }
  addText(text) { this.text.append(text); }
  flushText() {
    if (this.text.length) { this.parts.push({ text: this.text.text() }); this.text = new Fragments(); }
  }
  addCalls(calls) { if (calls.length) { this.flushText(); this.parts.push({ calls }); } }
  finish() { this.flushText(); return this.parts; }
}

/** Each arriving character is inspected once; the accumulated text is never rescanned. */
class JsonFrame {
  constructor(first) { this.stack = [first]; this.quoted = false; this.escape = false; this.first = true; this.invalid = false; }
  accept(char) {
    if (this.quoted) {
      if (this.escape) this.escape = false;
      else if (char === '\\') this.escape = true;
      else if (char === '"') this.quoted = false;
      return false;
    }
    if (this.first && !SPACE.test(char)) {
      this.first = false;
      const allowed = this.stack[0] === '{' ? char === '"' || char === '}' : /["{\[\]\-0-9tfn]/.test(char);
      if (!allowed) this.invalid = true;
    }
    if (char === '"') this.quoted = true;
    else if (char === '{' || char === '[') this.stack.push(char);
    else if (char === '}' || char === ']') {
      const top = this.stack.pop();
      if ((char === '}' && top !== '{') || (char === ']' && top !== '[')) this.invalid = true;
    }
    return this.stack.length === 0;
  }
}

function tagFromText(text) {
  // Text-only upstreams also emit shortened or pipe-prefixed closing tokens.
  if (/^<\/(?:\|tool_call|call)>$/i.test(text)) return { name: 'tool_call', closing: true, length: text.length };
  const match = /^<(\/?)(?:seed:)?(tool[_-]calls?|call_(?:calls?|tools?)|call-tools?)(?=[\s>])/i.exec(text);
  if (!match || !text.endsWith('>')) return null;
  const tail = text.slice(match[0].length, -1);
  if (match[1] ? tail.trim() !== '' : !/^(?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*$/.test(tail)) return null;
  // Upstreams mix the spellings, but singular and plural still delimit different groups.
  return { name: match[2].toLowerCase().endsWith('s') ? 'tool_calls' : 'tool_call', closing: Boolean(match[1]), length: text.length };
}

class TagFrame {
  constructor(context, lineStart = false) { this.context = context; this.lineStart = lineStart; this.raw = new Fragments(); this.raw.append('<'); this.head = '<'; this.tail = false; this.quote = ''; }
  accept(char) {
    this.raw.append(char);
    if (!this.tail) {
      if (char === '>') return tagFromText(this.raw.text()) ? 'complete' : 'invalid';
      if (SPACE.test(char) && TAG_PREFIXES.includes(this.head.toLowerCase())) { this.tail = true; return 'pending'; }
      this.head += char;
      return TAG_PREFIXES.some((prefix) => prefix.startsWith(this.head.toLowerCase())) ? 'pending' : 'invalid';
    }
    if (this.quote) { if (char === this.quote) this.quote = ''; }
    else if (char === '"' || char === "'") this.quote = char;
    else if (char === '>') return tagFromText(this.raw.text()) ? 'complete' : 'invalid';
    else if (char === '<') return 'invalid';
    return 'pending';
  }
}

function stringEnd(source, start) {
  let escape = false;
  for (let i = start + 1; i < source.length; i++) {
    if (escape) escape = false;
    else if (source[i] === '\\') escape = true;
    else if (source[i] === '"') return i + 1;
  }
  return -1;
}

function valueEnd(source, start) {
  const first = source[start];
  if (first === '"') return stringEnd(source, start);
  if (first === '{' || first === '[') {
    const frame = new JsonFrame(first);
    for (let i = start + 1; i < source.length; i++) if (frame.accept(source[i])) return i + 1;
    return -1;
  }
  let i = start;
  while (i < source.length && !/[\s,}\]]/.test(source[i])) i++;
  return i > start ? i : -1;
}

const skipSpace = (source, start) => { while (start < source.length && SPACE.test(source[start])) start++; return start; };

/** Index only this object's fields. Argument subtrees stay opaque raw ranges. */
function fieldsOf(source, start, end) {
  const fields = new Map();
  let i = skipSpace(source, start + 1);
  while (i < end - 1) {
    const keyEnd = stringEnd(source, i);
    if (keyEnd < 0) return null;
    const key = JSON.parse(source.slice(i, keyEnd));
    if (fields.has(key)) return null;
    i = skipSpace(source, keyEnd);
    if (source[i++] !== ':') return null;
    i = skipSpace(source, i);
    const next = valueEnd(source, i);
    if (next < 0) return null;
    fields.set(key, { start: i, end: next });
    i = skipSpace(source, next);
    if (source[i] === ',') i = skipSpace(source, i + 1);
    else break;
  }
  return fields;
}

function arrayRanges(source, start, end) {
  const ranges = [];
  let i = skipSpace(source, start + 1);
  while (i < end - 1) {
    const next = valueEnd(source, i);
    if (next < 0) return null;
    ranges.push({ start: i, end: next });
    i = skipSpace(source, next);
    if (source[i] === ',') i = skipSpace(source, i + 1);
    else break;
  }
  return ranges;
}

const validName = (value) => typeof value === 'string' && value.length > 0 && !/[\s<>"'\u0000-\u001f\u007f]/u.test(value);
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const schemaTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
function looksLikeSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (['$schema', '$ref', '$defs', 'properties', 'required', 'additionalProperties', 'oneOf', 'anyOf', 'allOf', 'items'].some((key) => Object.hasOwn(value, key))) return true;
  return schemaTypes.has(value.type) || (Array.isArray(value.type) && value.type.length > 0 && value.type.every((type) => schemaTypes.has(type)));
}

function callsFromValue(source, range, value, wrapped = false) {
  if (Array.isArray(value)) {
    const ranges = arrayRanges(source, range.start, range.end);
    if (!ranges || !value.length) return null;
    const calls = [];
    for (let i = 0; i < value.length; i++) {
      const items = callsFromValue(source, ranges[i], value[i], wrapped);
      if (!items) return null;
      calls.push(...items);
    }
    return calls;
  }
  if (!value || typeof value !== 'object') return null;
  const fields = fieldsOf(source, range.start, range.end);
  if (!fields) return null;
  for (const key of ['tool_calls', 'calls']) {
    if (Object.hasOwn(value, key)) return Array.isArray(value[key])
      ? callsFromValue(source, fields.get(key), value[key], wrapped) : null;
  }
  if (Object.hasOwn(value, 'type') && value.type !== 'function') return null;
  let fn = value, fnFields = fields;
  const nested = ['function', 'function_call'].find((key) => value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]));
  if (nested) {
    fn = value[nested];
    const nestedRange = fields.get(nested);
    fnFields = fieldsOf(source, nestedRange.start, nestedRange.end);
    if (!fnFields) return null;
  }
  const name = fn.name ?? fn.tool ?? fn.tool_name ?? (typeof fn.function === 'string' ? fn.function : undefined);
  if (!validName(name)) return null;
  const key = ARGUMENT_KEYS.find((key) => Object.hasOwn(fn, key));
  let argumentsText;
  if (key == null) {
    if (!wrapped) return null;
    argumentsText = '{}';
  } else {
    const argument = fn[key], argumentRange = fnFields.get(key);
    if (typeof argument === 'string') {
      let decoded;
      try { decoded = JSON.parse(argument); } catch { return null; }
      if (decoded === null || typeof decoded !== 'object') return null;
      if (!wrapped && key === 'parameters' && looksLikeSchema(decoded)) return null;
      argumentsText = argument;
    } else if (argument !== null && typeof argument === 'object') {
      // Bare tool definitions use function.parameters for JSON Schema. They are
      // ordinary data unless an explicit tool marker establishes call intent.
      if (!wrapped && key === 'parameters' && looksLikeSchema(argument)) return null;
      argumentsText = source.slice(argumentRange.start, argumentRange.end);
    } else return null;
  }
  const id = value.id ?? fn.id;
  return [{ ...(validId(id) ? { id } : {}), name, arguments: argumentsText }];
}

function completeTagAt(source, start) {
  const frame = new TagFrame('static');
  for (let i = start + 1; i < source.length; i++) {
    const state = frame.accept(source[i]);
    if (state === 'invalid') return null;
    if (state === 'complete') return { ...tagFromText(frame.raw.text()), start, end: i + 1 };
  }
  return null;
}

/** Parse a full payload/array/sequence, retaining raw argument JSON spelling. */
export function parseJsonToolCalls(payload) {
  if (typeof payload !== 'string' || !payload.trim()) return null;
  const source = payload;
  let index = 0;
  const sequence = (closingName = null, wrapped = false) => {
    const calls = [];
    let fenced = false, fenceClosed = false;
    for (;;) {
      index = skipSpace(source, index);
      if (index === source.length) return closingName || fenced ? null : calls;
      if (source.startsWith('```', index)) {
        if (fenceClosed) return null;
        if (fenced) { index += 3; fenced = false; fenceClosed = true; continue; }
        if (calls.length) return null;
        const header = /^```(?:json|javascript|js)?[ \t]*(?:\r?\n)?/i.exec(source.slice(index));
        index += header[0].length; fenced = true; continue;
      }
      if (source[index] === '<') {
        const tag = completeTagAt(source, index);
        if (!tag) return null;
        if (tag.closing) {
          if (!closingName || tag.name !== closingName || fenced) return null;
          index = tag.end; return calls;
        }
        if (fenceClosed) return null;
        index = tag.end;
        const inner = sequence(tag.name, true);
        if (!inner) return null;
        calls.push(...inner); continue;
      }
      if (fenceClosed || (source[index] !== '{' && source[index] !== '[')) return null;
      const start = index, end = valueEnd(source, start);
      if (end < 0) return null;
      let value;
      try { value = JSON.parse(source.slice(start, end)); } catch { return null; }
      const parsed = callsFromValue(source, { start, end }, value, wrapped);
      if (!parsed) return null;
      calls.push(...parsed); index = end;
    }
  };
  try { return sequence(); } catch { return null; }
}

/** Ordered streaming parts preserve text/call boundaries for composition with DSML. */
export class JsonToolStream {
  constructor({ maxHold = DEFAULT_LIMIT, allowFencedToolCalls = false, allowQoderMixedClose = false } = {}) {
    this.maxHold = maxHold; this.allowFencedToolCalls = allowFencedToolCalls;
    this.allowQoderMixedClose = allowQoderMixedClose; this.reset();
  }
  reset() {
    this.mode = 'plain'; this.json = null; this.chain = null; this.wrapper = null; this.tag = null;
    this.fenced = false; this.ticks = 0; this.fenceOpening = ''; this.fence = null; this.linePrefix = '';
  }
  checkLimit() {
    const length = (this.chain?.raw.length || 0) + (this.json?.raw.length || 0)
      + (this.wrapper?.raw.length || 0) + (this.tag?.raw.length || 0)
      + (this.fence?.raw.length || 0) + this.fenceOpening.length;
    if (length > this.maxHold) throw new Error('上游 JSON 工具调用超过解析长度上限');
  }
  trackLine(char) {
    if (!this.allowFencedToolCalls && !this.allowQoderMixedClose) return;
    if (char === '\n' || char === '\r') this.linePrefix = '';
    else if (this.linePrefix !== null) this.linePrefix = char === ' ' && this.linePrefix.length < 3 ? this.linePrefix + char : null;
  }
  startFence() {
    const raw = new Fragments(); raw.append(this.fenceOpening);
    this.fence = { raw, opening: true, header: this.fenceOpening, ticks: 3,
      markerEnded: false, eligible: false, bodyStart: 0, lineStart: 0 };
    this.fenceOpening = ''; this.ticks = 0;
    this.resetFenceLine();
  }
  resetFenceLine() {
    Object.assign(this.fence, { closePossible: true, closeIndent: 0, closeTicks: 0, closeTail: false, closeCR: false });
  }
  finishFence(output) {
    const fence = this.fence, raw = fence.raw.text();
    if (fence.inert) { this.fence = null; return; }
    let calls = null;
    if (fence.eligible) {
      const body = raw.slice(fence.bodyStart, fence.lineStart);
      try {
        const value = JSON.parse(body);
        // A fenced example/object/schema is data. Only the explicit machine
        // envelope used by this opt-in transport establishes tool-call intent.
        if (value && !Array.isArray(value) && typeof value === 'object'
          && Object.keys(value).length === 1 && Array.isArray(value.tool_calls) && value.tool_calls.length) {
          const parsed = parseJsonToolCalls(body);
          if (parsed?.length === value.tool_calls.length && parsed.every((call) => {
            const args = JSON.parse(call.arguments);
            return args !== null && typeof args === 'object' && !Array.isArray(args);
          })) calls = parsed;
        }
      } catch { /* Malformed frames remain inert, verbatim text. */ }
    }
    this.fence = null;
    if (calls) output.addCalls(calls); else output.addText(raw);
  }
  fenceChar(char, output) {
    const fence = this.fence;
    if (fence.inert) output.addText(char);
    else fence.raw.append(char);
    if (fence.opening) {
      if (fence.header.length < 256) fence.header += char;
      else fence.overlongHeader = true;
      if (!fence.markerEnded) {
        if (char === '`') fence.ticks++;
        else fence.markerEnded = true;
      }
      if (char === '\n') {
        fence.eligible = !fence.overlongHeader && /^`{3,}[ \t]*(?:json)?[ \t]*\r?\n$/i.test(fence.header);
        fence.opening = false; fence.bodyStart = fence.raw.length; fence.lineStart = fence.raw.length;
        // Once the language excludes tool envelopes, stream the code as data
        // immediately instead of holding an unrelated long HTML/JS response.
        if (!fence.eligible) { output.addText(fence.raw.text()); fence.raw = new Fragments(); fence.inert = true; }
        this.resetFenceLine();
      }
      return;
    }
    if (char === '\n') {
      if (fence.closePossible && fence.closeTicks >= fence.ticks) this.finishFence(output);
      else { fence.lineStart = fence.raw.length; this.resetFenceLine(); }
      return;
    }
    if (!fence.closePossible) return;
    if (char === '\r') { fence.closeCR = true; return; }
    if (fence.closeCR) { fence.closePossible = false; return; }
    if (!fence.closeTicks) {
      if (char === ' ' && fence.closeIndent < 3) fence.closeIndent++;
      else if (char === '`') fence.closeTicks++;
      else fence.closePossible = false;
    } else if (!fence.closeTail && char === '`') fence.closeTicks++;
    else if ((char === ' ' || char === '\t') && fence.closeTicks >= fence.ticks) fence.closeTail = true;
    else fence.closePossible = false;
  }
  plain(char, output) {
    output.addText(char);
    if (char === '`') { this.ticks++; if (this.ticks === 3) { this.fenced = !this.fenced; this.ticks = 0; } }
    else this.ticks = 0;
  }
  startJson(char) { this.json = { frame: new JsonFrame(char), raw: new Fragments() }; this.json.raw.append(char); this.mode = 'json'; }
  startWrapper(raw, tag, lineStart = false) {
    this.wrapper = { raw: new Fragments(), stack: [tag.name], json: null, invalid: false,
      mixedCloseEligible: lineStart && raw === '<tool_call>' };
    this.wrapper.raw.append(raw); this.mode = 'wrapper';
  }
  // Qoder has emitted a complete XML-framed call with one observed DSML
  // parameter closer. The caller validates that exact foreign token first.
  // Never infer a missing JSON tail, nested boundary or inline operation.
  closeQoderMixedWrapper() {
    const wrapper = this.wrapper;
    if (!this.allowQoderMixedClose || this.mode !== 'wrapper' || !wrapper?.mixedCloseEligible
      || wrapper.invalid || wrapper.stack.length !== 1 || wrapper.stack[0] !== 'tool_call'
      || wrapper.json || this.json || this.tag || this.chain || this.fence) return null;
    const closing = '</tool_call>';
    const payload = wrapper.raw.text().slice('<tool_call>'.length);
    let value;
    try { value = JSON.parse(payload); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const calls = parseJsonToolCalls(payload);
    if (calls?.length !== 1) return null;
    try {
      const args = JSON.parse(calls[0].arguments);
      if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    } catch { return null; }
    return this.push(closing);
  }
  observeDsmlBoundary(literal) {
    if (!this.allowQoderMixedClose) return;
    if (typeof literal !== 'string') { this.linePrefix = null; this.ticks = 0; return; }
    // DSML parts bypass push(). They still occupy their real source line and
    // must not erase surrounding code fences before the next XML candidate.
    for (const char of literal) {
      this.trackLine(char);
      if (char === '`') { this.ticks++; if (this.ticks === 3) { this.fenced = !this.fenced; this.ticks = 0; } }
      else this.ticks = 0;
    }
  }
  emitChain(output) { if (this.chain) output.addCalls(this.chain.calls); this.chain = null; }
  restoreChain(output) { if (this.chain) output.addText(this.chain.raw.text()); this.chain = null; }
  finishTag(state, output) {
    const frame = this.tag, raw = frame.raw.text();
    this.tag = null;
    const tag = state === 'complete' ? tagFromText(raw) : null;
    if (frame.context === 'wrapper') {
      const wrapper = this.wrapper;
      wrapper.raw.append(raw); this.mode = 'wrapper';
      if (!tag) return;
      if (!tag.closing) { wrapper.stack.push(tag.name); wrapper.mixedCloseEligible = false; }
      else {
        if (wrapper.stack.at(-1) === tag.name) wrapper.stack.pop();
        else if (wrapper.stack[0] === tag.name) { wrapper.stack = []; wrapper.invalid = true; }
        else wrapper.invalid = true;
        if (!wrapper.stack.length) {
          const text = wrapper.raw.text();
          const calls = wrapper.invalid ? null : parseJsonToolCalls(text);
          if (calls) output.addCalls(calls); else output.addText(text);
          this.wrapper = null; this.mode = 'plain';
        }
      }
      return;
    }
    if (!tag) { this.restoreChain(output); this.mode = 'plain'; output.addText(raw); return; }
    if (frame.context === 'tentative' && tag.closing) {
      this.emitChain(output); this.mode = 'plain'; return;
    }
    if (!tag.closing) {
      this.emitChain(output); this.startWrapper(raw, tag, frame.lineStart); return;
    }
    // A standalone closing marker with no qualifying JSON is data, not a call.
    this.mode = 'plain'; output.addText(raw);
  }
  push(chunk = '') {
    const output = new Parts();
    for (const char of chunk) {
      if (this.fence) {
        this.fenceChar(char, output); this.trackLine(char); this.checkLimit(); continue;
      }
      if (this.fenceOpening) {
        if (char === '`') {
          this.fenceOpening += char;
          if (this.fenceOpening.length === 3) this.startFence();
          this.trackLine(char); this.checkLimit(); continue;
        }
        for (const tick of this.fenceOpening) this.plain(tick, output);
        this.fenceOpening = '';
      }
      if (this.allowFencedToolCalls && this.mode === 'plain' && !this.tag && !this.fenced
        && this.linePrefix !== null && char === '`') {
        this.fenceOpening = char; this.trackLine(char); continue;
      }
      if (this.tag) {
        const state = this.tag.accept(char);
        if (state !== 'pending') this.finishTag(state, output);
      } else if (this.mode === 'json') {
        this.json.raw.append(char);
        const complete = this.json.frame.accept(char);
        if (complete || this.json.frame.invalid) {
          const raw = this.json.raw.text();
          const calls = complete && !this.json.frame.invalid ? parseJsonToolCalls(raw) : null;
          this.json = null;
          if (!calls) { this.restoreChain(output); output.addText(raw); this.mode = 'plain'; }
          else {
            this.chain ||= { raw: new Fragments(), calls: [] };
            this.chain.raw.append(raw); this.chain.calls.push(...calls); this.mode = 'tentative';
          }
        }
      } else if (this.mode === 'wrapper') {
        const wrapper = this.wrapper;
        if (char === '<' && !wrapper.json?.quoted) { this.tag = new TagFrame('wrapper'); }
        else {
          wrapper.raw.append(char);
          if (wrapper.json) { if (wrapper.json.accept(char)) wrapper.json = null; }
          else if (char === '{' || char === '[') wrapper.json = new JsonFrame(char);
        }
      } else if (this.mode === 'tentative') {
        if (SPACE.test(char)) this.chain.raw.append(char);
        else if (char === '<') this.tag = new TagFrame('tentative', this.linePrefix !== null);
        else if (char === '{' || char === '[') this.startJson(char);
        else { this.restoreChain(output); this.mode = 'plain'; this.plain(char, output); }
      } else if (!this.fenced && char === '<') this.tag = new TagFrame('plain', this.linePrefix !== null);
      else if (!this.fenced && (char === '{' || char === '[')) this.startJson(char);
      else this.plain(char, output);
      this.trackLine(char);
      this.checkLimit();
    }
    return output.finish();
  }
  flush({ preserveTextContext = false } = {}) {
    const output = new Parts();
    if (this.fence) {
      if (this.fence.inert) { /* This non-JSON fence already streamed as data. */ }
      else if (!this.fence.opening && this.fence.closePossible && this.fence.closeTicks >= this.fence.ticks) this.finishFence(output);
      else output.addText(this.fence.raw.text());
    } else if (this.fenceOpening) output.addText(this.fenceOpening);
    else if (this.wrapper) output.addText(this.wrapper.raw.text() + (this.tag?.raw.text() || ''));
    else if (this.json) { this.restoreChain(output); output.addText(this.json.raw.text()); }
    else if (this.tag) { this.restoreChain(output); output.addText(this.tag.raw.text()); }
    else this.emitChain(output);
    const context = preserveTextContext && this.allowQoderMixedClose
      ? { linePrefix: this.linePrefix, fenced: this.fenced || Boolean(this.fence), ticks: this.ticks } : null;
    this.reset();
    if (context) Object.assign(this, context);
    return output.finish();
  }
  static parsePayload(payload) {
    const calls = parseJsonToolCalls(payload);
    if (calls?.length === 1) return calls[0];
    // Retain the old explicitly requested name({...}) helper, never used to
    // classify bare stream prose or ordinary JSON.
    if (typeof payload !== 'string') return null;
    const match = /^(?:function\s*=\s*)?([^\s()<>{}]+)\s*\(([\s\S]*)\)\s*$/.exec(payload.trim());
    if (!match || !validName(match[1])) return null;
    let args;
    try { args = JSON.parse(match[2]); } catch { return null; }
    return args && typeof args === 'object' ? { name: match[1], arguments: match[2].trim() } : null;
  }
}
