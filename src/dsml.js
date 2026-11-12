/** DeepSeek DSML is a raw-string protocol, not XML. No entity expansion or code execution.
 * Official references:
 * https://huggingface.co/deepseek-ai/DeepSeek-V3.2/raw/main/encoding/encoding_dsv32.py
 * https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/raw/main/encoding/README.md
 */
const PIPE = /[|｜∣│]/u;
const NAMES = ['function_calls', 'tool_calls', 'calls', 'invoke', 'parameter'];
const HEADER = /<(\/?)[|｜∣│]{1,2}DSML[|｜∣│]{1,2}\s*(function_calls|tool_calls|calls|invoke|parameter)(?=[\s/>])/giu;
const ATTR_START = /[A-Za-z_:]/;
const ATTR_CHAR = /[A-Za-z0-9_.:-]/;
const SPACE = /\s/u;
const INLINE_ARGUMENTS = /^\s+name\s*=\s*(["'])arguments\1\s*:/iu;

/** Track the inline JSON object and its final '>' across stream chunks. */
export class DsmlInlineArguments {
  constructor() { this.stack = null; this.quoted = false; this.escape = false; this.bad = false; }

  accept(char) {
    if (this.bad) return false;
    if (!this.stack) {
      if (char === '{') this.stack = ['{'];
      else if (!SPACE.test(char)) this.bad = true;
      return false;
    }
    if (!this.stack.length) {
      if (char === '>') return true;
      if (!SPACE.test(char)) this.bad = true;
      return false;
    }
    if (this.quoted) {
      if (char.charCodeAt(0) < 32) this.bad = true;
      else if (this.escape) this.escape = false;
      else if (char === '\\') this.escape = true;
      else if (char === '"') this.quoted = false;
    } else if (char === '"') this.quoted = true;
    else if (char === '{' || char === '[') {
      this.stack.push(char);
      if (this.stack.length > 1024) this.bad = true;
    } else if (char === '}' || char === ']') {
      if (this.stack.pop() !== (char === '}' ? '{' : '[')) this.bad = true;
    } else if (!/[\s,:0-9eE+\-.aeflnrstu]/u.test(char)) this.bad = true;
    return false;
  }
}

function readInlineArguments(source, offset) {
  const frame = new DsmlInlineArguments();
  for (let i = offset; i < source.length && !frame.bad; i++) {
    if (!frame.accept(source[i])) continue;
    const json = source.slice(offset, i).trim();
    try { JSON.parse(json); } catch { return null; }
    return { json, end: i + 1 };
  }
  return null;
}

function attributesOf(text, closing) {
  if (closing) return text.trim() ? null : {};
  const entries = [];
  const seen = new Set();
  let i = 0;
  while (i < text.length) {
    if (!SPACE.test(text[i])) return null;
    while (i < text.length && SPACE.test(text[i])) i++;
    if (i === text.length) break;
    if (!ATTR_START.test(text[i])) return null;
    const start = i++;
    while (i < text.length && ATTR_CHAR.test(text[i])) i++;
    const name = text.slice(start, i).toLowerCase();
    while (i < text.length && SPACE.test(text[i])) i++;
    if (text[i++] !== '=') return null;
    while (i < text.length && SPACE.test(text[i])) i++;
    const quote = text[i++];
    if (quote !== '"' && quote !== "'") return null;
    const end = text.indexOf(quote, i);
    if (end < 0 || seen.has(name)) return null;
    seen.add(name);
    entries.push([name, text.slice(i, end)]);
    i = end + 1;
  }
  return Object.fromEntries(entries);
}

/** Find the first complete, lexically valid DSML tag at/after offset.
 * start/end are JS string indexes, end exclusive. Wrapper aliases normalize to
 * kind:'calls'; tagName retains calls/function_calls/tool_calls for strict pairing.
 * null means no complete tag; use isDsmlTagPrefix for an unfinished trailing tag.
 */
function scanPrefixedTag(source, offset = 0, allowInlineArguments = false) {
  if (typeof source !== 'string') return null;
  const pattern = new RegExp(HEADER.source, HEADER.flags);
  pattern.lastIndex = Math.max(0, offset);
  let match;
  while ((match = pattern.exec(source))) {
    const tagName = match[2].toLowerCase();
    let quote = '';
    let end = match.index + match[0].length;
    if (allowInlineArguments && !match[1] && tagName === 'parameter') {
      const inline = INLINE_ARGUMENTS.exec(source.slice(end));
      if (inline) return { kind: 'inlineArguments', start: match.index, end: end + inline[0].length };
    }
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') break;
    }
    if (source[end] !== '>' || quote) continue;
    const closing = Boolean(match[1]);
    const attributes = attributesOf(source.slice(match.index + match[0].length, end), closing);
    if (!attributes) continue;
    return { kind: tagName.endsWith('calls') ? 'calls' : tagName, tagName,
      closing, start: match.index, end: end + 1, attributes };
  }
  return null;
}

/** Bare parameter tags and function-name closes are recognized only when the
 * caller explicitly supplies an already-open DSML invoke's context. */
export function scanDsmlTag(source, offset = 0, { allowBareParameters = false, invokeName = null, allowInlineArguments = false } = {}) {
  if (typeof source !== 'string') return null;
  const candidates = [scanPrefixedTag(source, offset, allowInlineArguments && Boolean(invokeName))];
  if (allowBareParameters) {
    const pattern = /<(\/?)(parameter)(?=[\s>])/giu;
    pattern.lastIndex = Math.max(0, offset);
    let match;
    while ((match = pattern.exec(source))) {
      let quote = '', end = match.index + match[0].length;
      for (; end < source.length; end++) {
        const char = source[end];
        if (quote) { if (char === quote) quote = ''; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === '>' || char === '<') break;
      }
      if (source[end] !== '>' || quote) continue;
      const closing = Boolean(match[1]);
      const attributes = attributesOf(source.slice(match.index + match[0].length, end), closing);
      if (!attributes) continue;
      candidates.push({ kind: 'parameter', tagName: 'parameter', closing, start: match.index, end: end + 1, attributes, bare: true });
      break;
    }
  }
  if (typeof invokeName === 'string' && invokeName) {
    const escaped = invokeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`</${escaped}\\s*>`, 'gu');
    pattern.lastIndex = Math.max(0, offset);
    const match = pattern.exec(source);
    if (match) candidates.push({ kind: 'invoke', tagName: invokeName, closing: true,
      start: match.index, end: match.index + match[0].length, attributes: {}, namedClosing: true });
  }
  return candidates.filter(Boolean).sort((a, b) => a.start - b.start)[0] || null;
}

/** True only when the entire string could become a valid DSML tag by appending.
 * It intentionally accepts '<' and '</' so a streaming caller can hold a suffix.
 * Complete tags, ordinary prose and malformed tags return false.
 */
export function isDsmlTagPrefix(source, { allowBareParameters = false, invokeName = null } = {}) {
  if (typeof source !== 'string' || !source.startsWith('<')) return false;
  if (allowBareParameters) {
    const lower = source.toLowerCase();
    for (const prefix of ['<parameter', '</parameter']) {
      if (prefix.startsWith(lower)) return true;
      if (lower.startsWith(prefix)) {
        // Reuse the strict attribute-prefix validator with a DSML namespace.
        const normalized = '<' + (prefix[1] === '/' ? '/' : '') + '|DSML|parameter' + source.slice(prefix.length);
        if (isDsmlTagPrefix(normalized)) return true;
      }
    }
  }
  if (typeof invokeName === 'string' && invokeName) {
    const prefix = `</${invokeName}`;
    if (prefix.startsWith(source) || (source.startsWith(prefix) && source.slice(prefix.length).trim() === '')) return true;
  }
  let i = 1;
  if (i === source.length) return true;
  const closing = source[i] === '/';
  if (closing) { i++; if (i === source.length) return true; }
  const pipes = () => {
    const start = i;
    while (i < source.length && PIPE.test(source[i])) i++;
    return i - start;
  };
  const left = pipes();
  if (left < 1 || left > 2) return false;
  if (i === source.length) return true;
  for (const char of 'DSML') {
    if (i === source.length) return true;
    if (source[i++].toUpperCase() !== char) return false;
  }
  const right = pipes();
  if (right < 1 || right > 2) return i === source.length && right === 0;
  if (i === source.length) return true;
  while (i < source.length && SPACE.test(source[i])) i++;
  if (i === source.length) return true;
  const start = i;
  while (i < source.length && /[A-Za-z_]/.test(source[i])) i++;
  const name = source.slice(start, i).toLowerCase();
  if (i === source.length) return NAMES.some((n) => n.startsWith(name));
  if (!NAMES.includes(name)) return false;
  if (closing) return source.slice(i).trim() === '';
  // Validate a potentially incomplete quoted attribute list without accepting '>'.
  while (i < source.length) {
    if (!SPACE.test(source[i])) return false;
    while (i < source.length && SPACE.test(source[i])) i++;
    if (i === source.length) return true;
    if (!ATTR_START.test(source[i])) return false;
    i++;
    while (i < source.length && ATTR_CHAR.test(source[i])) i++;
    if (i === source.length) return true;
    while (i < source.length && SPACE.test(source[i])) i++;
    if (i === source.length) return true;
    if (source[i++] !== '=') return false;
    while (i < source.length && SPACE.test(source[i])) i++;
    if (i === source.length) return true;
    const quote = source[i++];
    if (quote !== '"' && quote !== "'") return false;
    const end = source.indexOf(quote, i);
    if (end < 0) return true;
    i = end + 1;
    if (i === source.length) return true;
  }
  return true;
}

function parameterValue(attributes, raw) {
  const string = attributes.string?.toLowerCase();
  const type = attributes.type?.toLowerCase();
  if (string != null && string !== 'true' && string !== 'false') return null;
  if (type && !['string', 'number', 'integer', 'boolean', 'object', 'array', 'null', 'json'].includes(type)) return null;
  // Missing type markers retain the raw value instead of guessing from its text.
  if (string === 'true' || (string == null && (!type || type === 'string'))) {
    if (type && type !== 'string') return null;
    return { json: JSON.stringify(raw) };
  }
  let value;
  let rawText = raw;
  try { value = JSON.parse(raw); } catch {
    // 模型常把 JSON 转义写错（\d 而不是 \\d）。孤立反斜杠在 JSON 里没有
    // 任何合法读法，翻倍是唯一合理解释 —— 这不是猜结构。
    const repaired = raw.replace(/\\(?![\\/"bfnrtu])/g, '\\\\');
    try { value = JSON.parse(repaired); } catch { return null; }
    rawText = repaired;
  }
  if (type === 'string' && typeof value !== 'string') return null;
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return null;
  if (type === 'integer' && !Number.isSafeInteger(value)) return null;
  if (type === 'boolean' && typeof value !== 'boolean') return null;
  if (type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) return null;
  if (type === 'array' && !Array.isArray(value)) return null;
  if (type === 'null' && value !== null) return null;
  // Keep the validated JSON source, rather than parse/stringify rounding large
  // integers or rewriting escaped strings inside object/array parameters.
  return { json: rawText.trim() };
}

/** Parse exactly one complete wrapper or one invoke; never consumes prose.
 * Returns [{name, arguments:<JSON string>}] or null for malformed/truncated input.
 * String bodies (including XML-looking entities and whitespace) stay byte-for-byte
 * equivalent after JSON decoding; non-string bodies use JSON.parse, never eval.
 */
export function parseDsmlCalls(source, { allowUnclosedWrapper = false } = {}) {
  if (typeof source !== 'string') return null;
  const text = source.trim();
  const at = (index, options) => { const tag = scanDsmlTag(text, index, options); return tag?.start === index ? tag : null; };
  const whitespace = (index) => { while (index < text.length && SPACE.test(text[index])) index++; return index; };
  const invoke = (open) => {
    const name = open.attributes.name;
    if (typeof name !== 'string' || !name || /[\s<>"'\u0000-\u001f\u007f]/u.test(name)) return null;
    const parameters = new Map();
    let argumentsRaw = null;
    const context = { allowBareParameters: true, invokeName: name };
    const parameterContext = { ...context, allowInlineArguments: true };
    let index = open.end;
    for (;;) {
      index = whitespace(index);
      const tag = at(index, parameterContext);
      if (!tag) return null;
      if (tag.kind === 'inlineArguments') {
        if (parameters.size) return null;
        const args = readInlineArguments(text, tag.end);
        const close = args && at(whitespace(args.end), context);
        if (!close?.closing || close.kind !== 'parameter' || close.bare) return null;
        const end = at(whitespace(close.end), context);
        if (!end?.closing || end.kind !== 'invoke') return null;
        return { call: { name, arguments: args.json }, end: end.end, inline: true };
      }
      if (tag.kind === 'invoke' && tag.closing) {
        let args;
        if (argumentsRaw != null && parameters.size === 0) {
          args = argumentsRaw;
        } else if (parameters.size === 1 && parameters.has('arguments')) {
          // 模型把完整参数对象写在名为 arguments 的 parameter 里：直接采用，
          // 不要再套一层 {"arguments": …}（与内联 name="arguments":{…} 形态一致）
          const candidate = parameters.get('arguments');
          let value = null;
          try { value = JSON.parse(candidate); } catch { /* 保守起见维持旧组合 */ }
          args = value && typeof value === 'object' && !Array.isArray(value)
            ? candidate
            : '{' + JSON.stringify('arguments') + ':' + candidate + '}';
        } else {
          args = '{' + [...parameters].map(([key, json]) => JSON.stringify(key) + ':' + json).join(',') + '}';
        }
        return { call: { name, arguments: args }, end: tag.end };
      }
      if (tag.kind === 'parameter' && tag.closing && parameters.size) { index = tag.end; continue; }
      if (tag.kind !== 'parameter' || tag.closing) return null;
      const key = tag.attributes.name;
      if (typeof key !== 'string' || !key || /[\u0000-\u001f\u007f]/u.test(key) || parameters.has(key)) return null;
      let close = null, cursor = tag.end, rawParameterDepth = 0;
      for (;;) {
        const next = scanDsmlTag(text, cursor, context);
        if (!next) break;
        // A literal, balanced <parameter> example is raw body text. A new
        // named parameter before the current close is ambiguous, so reject it.
        if (next.kind === 'parameter' && !next.closing && next.bare && !Object.hasOwn(next.attributes, 'name')) {
          rawParameterDepth++; cursor = next.end; continue;
        }
        if (next.kind === 'parameter' && next.closing && rawParameterDepth) {
          rawParameterDepth--; cursor = next.end; continue;
        }
        close = next; break;
      }
      if (!close?.closing || close.kind !== 'parameter') return null;
      const raw = text.slice(tag.end, close.start);
      const parameter = parameterValue(tag.attributes, raw);
      // 模型把整个参数对象写在名为 arguments 的 parameter 里（string="false"），
      // 但 JSON 转义常写错（\d 而不是 \\d 之类）。这时保底把原文透传下去：
      // 调用结构保留，工具执行端报错后模型会自己修正，而不是丢掉整个调用
      // 让标记原文漏给用户。
      argumentsRaw = !parameter && key === "arguments"
        && tag.attributes.string?.toLowerCase() === 'false' ? raw.trim() : null;
      if (!parameter && argumentsRaw == null) return null;
      if (parameter) parameters.set(key, parameter.json);
      index = close.end;
    }
  };
  const open = at(0);
  if (!open || open.closing || (open.kind !== 'calls' && open.kind !== 'invoke')) return null;
  if (open.kind === 'invoke') {
    const result = invoke(open);
    return result && whitespace(result.end) === text.length ? [result.call] : null;
  }
  if (Object.keys(open.attributes).length) return null;
  const calls = [];
  let hasInline = false;
  let index = open.end;
  for (;;) {
    index = whitespace(index);
    if (allowUnclosedWrapper && !hasInline && index === text.length && calls.length) return calls;
    const tag = at(index);
    if (!tag) return null;
    if (tag.kind === 'calls' && tag.closing) {
      return tag.tagName === open.tagName && calls.length && whitespace(tag.end) === text.length ? calls : null;
    }
    if (allowUnclosedWrapper && !hasInline && calls.length && tag.kind === 'calls' && !tag.closing
      && tag.tagName === open.tagName && !Object.keys(tag.attributes).length && whitespace(tag.end) === text.length) return calls;
    if (tag.kind !== 'invoke' || tag.closing) return null;
    const result = invoke(tag);
    if (!result) return null;
    calls.push(result.call);
    hasInline ||= result.inline === true;
    index = result.end;
  }
}
