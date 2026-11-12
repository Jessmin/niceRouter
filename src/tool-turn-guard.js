// Text tools end at the first model-authored result/role boundary. Tool results
// belong to the caller's next request, never to a continuation invented here.
const XML = ['<tool_result', '<tool-result', '<result'];
const BRACKETS = ['[工具结果', '[tool_result', '[tool result'];
const ROLES = ['assistant:', 'user:'];
const PREFIXES = [...XML, ...BRACKETS, ...ROLES];
const STARTS = new Set(PREFIXES.map((prefix) => prefix[0]));

export class ToolTurnGuard {
  constructor({ strictAfterCalls = false } = {}) {
    this.strictAfterCalls = strictAfterCalls;
    this.seenCalls = false; this.stopped = false; this.pending = ''; this.lineStart = true;
  }
  track(text) {
    for (const char of text) {
      if (char === '\n' || char === '\r') this.lineStart = true;
      else if (char !== ' ' && char !== '\t') this.lineStart = false;
    }
    return text;
  }
  pushText(text) {
    if (this.stopped) return '';
    if (!this.seenCalls) return this.track(text);
    if (this.strictAfterCalls) {
      // A text-tool caller owns execution. Adjacent parsed calls can extend the
      // current batch, but ordinary prose cannot start a simulated next turn.
      if (/\S/u.test(text)) this.stopped = true;
      return '';
    }
    const output = [];
    for (const char of text) {
      if (!this.pending) {
        if (this.lineStart && STARTS.has(char.toLowerCase())) this.pending = char;
        else { output.push(this.track(char)); continue; }
      } else this.pending += char;
      const lower = this.pending.toLowerCase();
      if (ROLES.includes(lower)
        || XML.some((tag) => lower.startsWith(tag) && /^[\s/>]$/.test(lower[tag.length] || ''))
        || BRACKETS.some((tag) => lower.startsWith(tag) && /^[\s\]:：]$/.test(lower[tag.length] || ''))) {
        this.stopped = true;
        this.pending = '';
        break;
      }
      if (PREFIXES.some((marker) => marker.startsWith(lower))) continue;
      output.push(this.track(this.pending));
      this.pending = '';
    }
    return output.join('');
  }
  beforeCalls() {
    const text = this.finish();
    this.seenCalls = true;
    return text;
  }
  finish() {
    if (this.stopped) return '';
    const pending = this.pending;
    this.pending = '';
    return this.track(pending);
  }
}
