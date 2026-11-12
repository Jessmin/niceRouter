import { DsmlInlineArguments, parseDsmlCalls, scanDsmlTag, isDsmlTagPrefix } from './dsml.js';

const MAX_BUFFER = 8 * 1024 * 1024;

// Track only a JSON candidate's lexical state; JsonToolStream owns its contents.
// Loose prose quotes never enter this state, and invalid candidates release it.
class JsonContext {
  constructor(open) { this.stack = [open]; this.quoted = false; this.escape = false; this.first = true; this.invalid = false; this.quarantine = false; }
  accept(char) {
    if (this.quarantine) return false;
    if (this.quoted) {
      // A raw newline damages JSON syntax, but never turns the remainder of an
      // unclosed string into independently executable DSML instructions.
      if (char.charCodeAt(0) < 32) { this.quarantine = true; return false; }
      if (this.escape) this.escape = false;
      else if (char === '\\') this.escape = true;
      else if (char === '"') this.quoted = false;
      return false;
    }
    if (this.first && !/\s/u.test(char)) {
      this.first = false;
      if (this.stack.at(-1) === '{' ? char !== '"' && char !== '}' : !/["{\[\]\-0-9tfn]/.test(char)) this.invalid = true;
    }
    if (char === '"') this.quoted = true;
    else if (char === '{' || char === '[') { this.stack.push(char); this.first = true; }
    else if (char === '}' || char === ']') {
      if (this.stack.pop() !== (char === '}' ? '{' : '[')) this.invalid = true;
    } else if (!/[\s,:0-9eE+\-.aeflnrstu]/u.test(char)) this.invalid = true;
    return this.stack.length === 0;
  }
}

/** Separates complete DSML calls from normal text without leaking split tags. */
export class DsmlStream {
  constructor() { this.buffer = ''; this.active = null; this.json = null; }

  outsideTag(input, offset) {
    for (let index = offset; index < input.length; index++) {
      const char = input[index];
      if (this.json) {
        const complete = this.json.accept(char);
        if (!this.json.invalid) {
          if (complete) this.json = null;
          continue;
        }
        this.json = null;
      }
      if (char === '{' || char === '[') { this.json = new JsonContext(char); continue; }
      if (char !== '<' || !isDsmlTagPrefix(input.slice(index, index + 8))) continue;
      const tag = scanDsmlTag(input, index);
      if (tag?.start === index) return { tag };
      if (isDsmlTagPrefix(input.slice(index))) return { hold: index };
    }
    return { hold: input.length };
  }

  append(text, parts) {
    if (!text) return;
    if (!this.active) { parts.push({ text }); return; }
    this.active.fragments.push(text);
    this.active.length += text.length;
    if (this.active.length > MAX_BUFFER) throw new Error('上游 DSML 工具调用超过解析长度上限');
  }

  push(text = '') {
    // Retain only an unfinished tag between scans. Large parameter bodies are
    // accumulated as fragments and joined once, rather than rescanned per token.
    const input = this.buffer + text;
    this.buffer = '';
    const parts = [];
    let offset = 0;
    while (offset < input.length) {
      const inline = this.active?.inlineArguments;
      if (inline) {
        const start = offset;
        while (offset < input.length && !inline.bad) {
          if (inline.accept(input[offset++])) { this.active.inlineArguments = null; break; }
        }
        if (inline.bad) offset = input.length;
        this.append(input.slice(start, offset), parts);
        continue;
      }
      const outside = this.active ? null : this.outsideTag(input, offset);
      const context = this.active ? { allowBareParameters: true, invokeName: this.active.invokeName,
        allowInlineArguments: this.active.parameterDepth === 0 } : undefined;
      const tag = this.active ? scanDsmlTag(input, offset, context) : outside.tag;
      if (!tag) {
        if (outside) {
          this.append(input.slice(offset, outside.hold), parts);
          this.buffer = input.slice(outside.hold);
          break;
        }
        const tail = input.slice(offset);
        const at = tail.lastIndexOf('<');
        const hold = at >= 0 && isDsmlTagPrefix(tail.slice(at), context) ? at : tail.length;
        this.append(tail.slice(0, hold), parts);
        this.buffer = tail.slice(hold);
        break;
      }
      this.append(input.slice(offset, tag.start), parts);
      const raw = input.slice(tag.start, tag.end);
      offset = tag.end;
      if (this.active) {
        this.append(raw, parts);
        if (tag.kind === 'inlineArguments') this.active.inlineArguments = new DsmlInlineArguments();
        if (tag.kind === 'invoke') {
          this.active.invokeName = tag.closing ? null : tag.attributes.name;
          this.active.parameterDepth = 0;
        }
        if (tag.kind === 'parameter' && this.active.invokeName) {
          this.active.parameterDepth = Math.max(0, this.active.parameterDepth + (tag.closing ? -1 : 1));
        }
        if (tag.kind === this.active.kind) this.active.depth += tag.closing ? -1 : 1;
        if (!this.active.depth) {
          const block = this.active.fragments.join('');
          const calls = parseDsmlCalls(block);
          parts.push(calls ? { calls } : { literal: block });
          this.active = null;
        }
      } else if (tag.closing || tag.kind === 'parameter') {
        parts.push({ literal: raw });
      } else {
        this.active = { kind: tag.kind, depth: 1, fragments: [], length: 0, parameterDepth: 0,
          invokeName: tag.kind === 'invoke' ? tag.attributes.name : null };
        this.append(raw, parts);
      }
    }
    if ((this.active?.length || 0) + this.buffer.length > MAX_BUFFER) throw new Error('上游 DSML 工具调用超过解析长度上限');
    return parts;
  }

  flush() {
    const parts = this.push();
    // Malformed or truncated markup must never turn into an executable call.
    const remaining = (this.active?.fragments.join('') || '') + this.buffer;
    if (remaining) {
      const calls = this.active ? parseDsmlCalls(remaining, { allowUnclosedWrapper: true }) : null;
      parts.push(calls ? { calls } : { literal: remaining });
    }
    this.buffer = '';
    this.active = null;
    this.json = null;
    return parts;
  }
}
