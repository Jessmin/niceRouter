/**
 * 统一工具标记引擎
 * ==================================================================
 * 替换原先「逐字符状态机 + 严格拒绝」的两段式实现（json-tool-stream +
 * dsml-stream + tool-turn-guard）。旧实现的根本问题不是某个格式没覆盖，而是
 * 三个设计选择叠在一起：
 *
 *   1. 边到边解析：每个 delta 都要在半个标记、半个 JSON、半个属性里做判断，
 *      于是每遇到一个新观测到的变体就得打一次补丁（混合闭合、行首限定、
 *      围栏位置…），补丁之间互相踩。
 *   2. 解析失败 = 抛错 = 整轮 502。用户侧表现为「返回了无法解析的工具调用
 *      标记，本轮未完成」，长对话上下文直接废掉，比少执行一次工具严重得多。
 *   3. 只认自己写在提示词里的那一种拼写。而真实模型（尤其 DeepSeek 系）会
 *      混着写：`<tool_call>` 开、DSML 收、`<function_calls>` 包、GLM 的
 *      arg_key/arg_value、裸 `<invoke>`……
 *
 * 本引擎的语义（与 magpie 的 textcalls 一致，是这套协议里最耐用的形态）：
 *
 *   - 扫描到「调用意图标记」就整段扣留，直到本轮结束才做一次完整解析。
 *     只有扣留点之前的正文是流式吐出的。这样解析永远面对完整字符串，
 *     不存在分帧边界问题 —— 分帧穷举测试因此可以 100% 通过。
 *   - 拿到完整文本后按「区域」解析：每个标记区间要么解析出声明过的工具 +
 *     可读的参数对象，要么连标记一起丢掉。绝不猜参数、绝不补 JSON。
 *   - 解析不出调用就把它当正文吐出去，并记账。整轮不会因为标记问题失败。
 *   - 校验底线不放宽：名字必须在本轮声明集合里、参数必须是完整 JSON 对象。
 *     放宽的只有「拼写容错」和「失败的处置方式」。
 */

import { parseJsonToolCalls } from './json-tool-stream.js';
import { DsmlInlineArguments, parseDsmlCalls, scanDsmlTag } from './dsml.js';

const MAX_HOLD = 8 * 1024 * 1024;
const MAX_TAG = 512;
/** 扫描到标记后最多回看多少字符判断「可能是半个标记」 */
const TAIL_LOOKBACK = 24;

/* ------------------------------ 记账 ------------------------------ */

const stats = {
  turns: 0, held_turns: 0, calls: 0, blocks: 0,
  junk: 0, unknown_tool: 0, bad_name: 0, bad_arguments: 0,
  truncated: 0, salvaged: 0, dropped_text: 0, rejected_blocks: 0,
  overflow: 0,
};

/** 进程级聚合，暴露在 /v1/status 用于观察真实世界里到底出现了哪些拼写。 */
export function markupStats() {
  return { ...stats };
}

function bump(code, n = 1) {
  if (quiet > 0) return;
  if (n > 0) stats[code] = (stats[code] || 0) + n;
}

/** 试探性解析（只为判断完整性）时不记账 */
let quiet = 0;

/* --------------------------- 词法小工具 --------------------------- */

const SPACE_CHAR = /[\s\uFEFF]/u;

function skipSpace(s, i) {
  while (i < s.length && SPACE_CHAR.test(s[i])) i += 1;
  return i;
}

function backtickRunEnd(s, start) {
  let end = start + 1;
  while (s[end] === '`') end += 1;
  return end;
}

/** 平衡 JSON 值扫描，字符串感知；返回结束下标（不含），无法确定返回 -1。 */
export function jsonValueEnd(s, start) {
  const first = s[start];
  if (first === '"') {
    let esc = false;
    for (let i = start + 1; i < s.length; i += 1) {
      if (esc) esc = false;
      else if (s[i] === '\\') esc = true;
      else if (s[i] === '"') return i + 1;
    }
    return -1;
  }
  if (first !== '{' && first !== '[') return -1;
  let depth = 0;
  let quoted = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/* --------------------------- 标记识别 --------------------------- */

const PIPE = '[|｜∣│]';
/** tool_call 家族：<tool_call> / <tool_calls> / <call_call> / <seed:tool_call> / <tool-call> */
const CALL_TAG = new RegExp(`^<\\s*(?:[A-Za-z_][\\w.-]*:)?(?:tool[_-]?calls?|call[_-]?(?:calls?|tools?)|tool[_-]?use)(?=[\\s/>])`, 'i');
/** 包裹层：<function_calls> */
const WRAPPER_TAG = /^<\s*(?:[A-Za-z_][\w.-]*:)?function_calls(?=[\s>])/i;
/** invoke：裸的、带命名空间的、带 DSML 管道前缀的 */
const INVOKE_TAG = new RegExp(`^<\\s*(?:(?:${PIPE}{1,3}\\s*DSML${PIPE}*|[A-Za-z_][\\w.-]*:)\\s*)?invoke(?=[\\s>])`, 'i');
/** DSML 标记（含管道变体） */
const DSML_HEAD = new RegExp(`^<\\s*(\\/)?\\s*${PIPE}{1,3}\\s*DSML${PIPE}*`, 'i');

/** 用于「半个标记」判断的完整标记名集合 */
const MARK_NAMES = [
  'tool_call', 'tool_calls', 'tool-call', 'tool-calls', 'call_call', 'call_calls',
  'call_tool', 'call_tools', 'call-tool', 'call-tools', 'tool_use', 'function_calls',
  'invoke', 'parameter', 'arg_key', 'arg_value', 'seed:tool_call', 'seed:tool_calls',
  'minimax:tool_call', 'minimax:tool_calls',
];

/**
 * 在 i 处是否有调用意图标记。
 * 只做「是不是标记」的判断；不判断标记内部结构，那是 readBlock 的事。
 */
function matchOpener(s, i, { allowBareJson, allowFenced, lineStart }) {
  const ch = s[i];
  if (ch === '`') {
    // 未启用围栏协议时，代码块整体当惰性正文：里面的示例 JSON 不许被执行
    if (!s.startsWith('```', i)) return null;
    return { kind: allowFenced ? 'fence' : 'inertFence' };
  }
  if (ch === '{' || ch === '[') {
    // 裸 JSON 只在行首才算候选：句子中间被引用的示例对象不许执行
    return allowBareJson && lineStart ? { kind: 'json' } : null;
  }
  if (ch !== '<') return null;
  const peek = s.slice(i, i + 48);
  const dsml = DSML_HEAD.exec(peek);
  if (dsml) return dsml[1] ? null : { kind: 'dsml' };
  if (CALL_TAG.test(peek)) return { kind: 'tag' };
  if (WRAPPER_TAG.test(peek)) return { kind: 'wrapper' };
  if (INVOKE_TAG.test(peek)) return { kind: 'invoke' };
  return null;
}

/** 行尾这 k 个字符会不会是某个标记的开头（用于流式扣留半个标记）。 */
function couldStartMark(tail) {
  if (!tail) return false;
  if (tail[0] === '`') return /^`+$/.test(tail);
  if (tail[0] !== '<') return false;
  if (tail.length === 1) return true;
  // 依次剥掉斜杠、空白、管道（DSML 的各种写法顺序不一）
  let rest = tail.slice(1).toLowerCase().replace(/^[\/\s|｜∣│]+/, '');
  if (!rest) return true;
  if ('dsml'.startsWith(rest)) return true;
  if (rest.startsWith('dsml')) {
    rest = rest.slice(4).replace(/^[\/\s|｜∣│]+/, '');
    if (!rest) return true;
  }
  // 只看标签名本身，后面的属性/闭合符号不参与判断
  rest = rest.split(/[\s>\/]/, 1)[0];
  if (!rest) return true;
  if (!/^[a-z0-9_:.\-]*$/.test(rest)) return false;
  return MARK_NAMES.some((name) => name.startsWith(rest) || rest.startsWith(`${name}:`));
}

function tailHoldLength(s) {
  const limit = Math.min(s.length, TAIL_LOOKBACK);
  for (let k = limit; k > 0; k -= 1) {
    if (couldStartMark(s.slice(-k))) return k;
  }
  return 0;
}

/** 悬空的闭合标签：出现在调用已提交之后时按垃圾丢掉，不能当正文外发。 */
const CLOSER_TAG = new RegExp(
  // 闭合标签有时带管道前缀（</|tool_call> 这种豆包/DSML 混写），一并兼容
  '^<\\s*\\/\\s*[|｜∣│]{0,3}\\s*(?:(?:[A-Za-z_][\\w.-]*:)?(?:tool[_-]?calls?|call[_-]?(?:calls?|tools?)|tool[_-]?use|function_calls|invoke|parameter|calls?|arg_key|arg_value)'
  + `|${PIPE}{1,3}\\s*DSML${PIPE}*\\s*(?:parameter|invoke|calls|tool_calls|function_calls|tool)?)\\s*>`
  + '|^<\\s*\\/\\s*[A-Za-z_][\\w.:-]*\\s*>'
  // DeepSeek 有时把 wrapper 收尾写成不带斜杠的 <｜｜DSML｜｜ calls>
  + `|^<\\s*${PIPE}{1,3}\\s*DSML${PIPE}*\\s*(?:calls|tool_calls|function_calls|tool)\\s*>`, 'i');

function matchCloserAt(s, i) {
  if (s[i] !== '<') return null;
  const m = CLOSER_TAG.exec(s.slice(i, i + MAX_TAG));
  return m ? { length: m[0].length } : null;
}

/** 收尾一个区块：吃掉尾部噪声，并记录它本身是否已经闭合。 */
const GROUP_CLOSER = new RegExp('<\\s*\\/\\s*(?:(?:[A-Za-z_][\\w.-]*:)?(?:tool[_-]?calls|call[_-]?tools|function_calls)' + '|' + PIPE + '{1,3}\\s*DSML' + PIPE + '*\\s*(?:calls|tool_calls|function_calls))\\s*>', 'i');

const GROUP_CLOSER_TAIL = new RegExp('(?:' + GROUP_CLOSER.source.replace(/^\^/, '') + ')[ \\t\\r\\n]*$', 'i');

function closedAt(s, end, calls, base = false) {
  const after = consumeClosers(s, end);
  // 组级闭合（</tool_calls> / <｜｜DSML｜｜ calls>）才说明整批调用写完了
  const group = after > end ? GROUP_CLOSER.test(s.slice(end, after)) : false;
  return { calls, end: after, closed: base || after > end, group };
}

/** 模型自己编的「工具结果 / 下一轮角色」开头：出现即说明该收尾了。 */
const FABRICATED = /^(?:<tool[-_]?result\b|<result\b|\[\s*(?:工具结果|tool[_ ]result)|user\s*:|assistant\s*:|tool\s*:)/i;

/** 剩余内容是不是只有空白和闭合标签（可以安全收尾）。 */
function junkOnly(text) {
  let tail = text;
  for (;;) {
    const trimmed = tail.replace(/^\s+/, '');
    if (!trimmed) return true;
    const closer = matchCloserAt(trimmed, 0);
    if (!closer) return false;
    tail = trimmed.slice(closer.length);
  }
}

/* --------------------------- 区域解析 --------------------------- */

const CLOSER = new RegExp(
  '^(?:\\s*)(?:'
  + '<\\s*\\/\\s*(?:(?:[A-Za-z_][\\w.-]*:)?(?:tool[_-]?calls?|call[_-]?(?:calls?|tools?)|tool[_-]?use|function_calls|invoke|parameter|calls?)'
  + `|${PIPE}{1,3}\\s*DSML${PIPE}*\\s*(?:parameter|invoke|calls|tool_calls|function_calls|tool)?)\\s*>`
  + '|[}\\]"\'>]'
  + ')', 'i');

/** 吃掉调用块后面那些「模型自己拼的收尾」：DSML 闭合、多余的工具标签、散落的括号。 */
function consumeClosers(s, start) {
  let i = start;
  let junk = 0;
  for (let guard = 0; guard < 64; guard += 1) {
    const m = CLOSER.exec(s.slice(i, i + MAX_TAG));
    if (!m) break;
    i += m[0].length;
    junk += 1;
  }
  if (junk) bump('junk', junk);
  return i;
}

const PARAM_AT = new RegExp(`^<\\s*(?:\\/?\\s*(?:${PIPE}{1,3}\\s*DSML${PIPE}*|[A-Za-z_][\\w.-]*:)\\s*)?parameter\\b([^>]*)>`, 'i');
const PARAM_CLOSE_AT = new RegExp(`^<\\s*\\/\\s*(?:${PIPE}{1,3}\\s*DSML${PIPE}*|[A-Za-z_][\\w.-]*:)?\\s*parameter\\s*>`, 'i');
const INVOKE_AT = new RegExp(`^<\\s*(?:(?:${PIPE}{1,3}\\s*DSML${PIPE}*|[A-Za-z_][\\w.-]*:)\\s*)?invoke\\b([^>]*)>`, 'i');
const INVOKE_CLOSE_AT = new RegExp(`^<\\s*\\/\\s*(?:${PIPE}{1,3}\\s*DSML${PIPE}*|[A-Za-z_][\\w.-]*:)?\\s*invoke\\s*>`, 'i');
const ARG_KEY_AT = /^<\s*arg_key\s*>/i;
const ARG_VALUE_AT = /^<\s*arg_value\s*>/i;
const ARG_VALUE_CLOSE_AT = /^<\s*\/\s*arg_value\s*>/i;
const ARG_KEY_CLOSE_AT = /^<\s*\/\s*arg_key\s*>/i;

const attrName = (attrs) => {
  const m = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs || '');
  return m ? (m[1] ?? m[2] ?? '') : '';
};

/** 结构化或标量文本 → JSON 值；否则保留原始字符串（命令、路径等不动一个字节）。 */
function scalarValue(text, schemaType) {
  const trimmed = text.trim();
  if (!trimmed) return text;
  switch (schemaType) {
    case 'string': return text;
    case 'integer': return /^-?\d{1,15}$/.test(trimmed) ? Number(trimmed) : text;
    case 'number': return /^-?\d{1,15}(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : text;
    case 'boolean': return trimmed === 'true' ? true : trimmed === 'false' ? false : text;
    default: break;
  }
  if (/^[{[][\s\S]*[}\]]$/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch {
      // 模型常把 JSON 转义写错（\d 而不是 \\d）。孤立反斜杠在 JSON 里没有
      // 任何合法读法，翻倍是唯一合理解释 —— 这不是猜结构。
      const repaired = trimmed.replace(/\\(?![\\/"bfnrtu])/g, '\\\\');
      try { return JSON.parse(repaired); } catch { return text; }
    }
  }
  // 没有 schema 时不做标量猜测：命令 `true` 不能变成布尔值。
  return text;
}

/**
 * parameter 取值：显式 `string="true"` 一律原样；有调用方工具 schema 时按 schema
 * 类型转换；其余只把结构化 JSON 转成对象，标量保持原始字符串。
 */
function paramValue(body, attrs, schemaType) {
  const string = (/\bstring\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs || '') || [])[1]?.toLowerCase();
  if (string === 'true') return body;
  return scalarValue(body, string === 'false' ? (schemaType || 'json') : schemaType);
}

/** 找 <parameter ...>…</parameter> 的闭合，支持一层以上嵌套。 */
function findParamClose(s, from) {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) return null;
    const peek = s.slice(lt, lt + MAX_TAG);
    const close = PARAM_CLOSE_AT.exec(peek);
    if (close) {
      depth -= 1;
      if (depth === 0) return { start: lt, end: lt + close[0].length };
      i = lt + close[0].length;
      continue;
    }
    const open = PARAM_AT.exec(peek);
    if (open) {
      depth += 1;
      i = lt + open[0].length;
      continue;
    }
    i = lt + 1;
  }
  return null;
}

/** 读一串 <parameter>，返回对象参数。 */
function readParams(s, start, types = null) {
  const args = {};
  let i = start;
  let broken = false;
  for (let guard = 0; guard < 256; guard += 1) {
    const at = skipSpace(s, i);
    const open = PARAM_AT.exec(s.slice(at, at + MAX_TAG));
    if (!open) break;
    const name = attrName(open[1]);
    if (!name) { broken = true; break; }
    const bodyStart = at + open[0].length;
    const close = findParamClose(s, bodyStart);
    // 参数开了没合上：不是「零参调用」，是残缺调用，绝不能当成 {} 执行
    if (!close) { broken = true; break; }
    const body = s.slice(bodyStart, close.start);
    // 嵌套 parameter 写成对象
    if (PARAM_AT.test(body.slice(skipSpace(body, 0), skipSpace(body, 0) + MAX_TAG))) {
      const inner = readParams(body, 0);
      args[name] = inner.args;
    } else {
      args[name] = paramValue(body, open[1], types?.[name]);
    }
    i = close.end;
  }
  return { args, end: i, broken };
}

/** 读 <invoke name=…>…</invoke> 序列（Claude / MiniMax / DSML 共用这套骨架）。 */
function readInvokeChain(s, start, types = null) {
  const calls = [];
  let i = start;
  for (let guard = 0; guard < 256; guard += 1) {
    const at = skipSpace(s, i);
    const open = INVOKE_AT.exec(s.slice(at, at + MAX_TAG));
    if (!open) break;
    const name = attrName(open[1]);
    if (!name) break;
    const bodyStart = at + open[0].length;
    // 闭合位置：本 invoke 的 </invoke>；DSML 里也可能是下一个 invoke 开头
    let depth = 1;
    let cursor = bodyStart;
    let bodyEnd = -1;
    let end = -1;
    while (cursor < s.length) {
      const lt = s.indexOf('<', cursor);
      if (lt < 0) break;
      const peek = s.slice(lt, lt + MAX_TAG);
      const close = INVOKE_CLOSE_AT.exec(peek);
      if (close) {
        depth -= 1;
        cursor = lt + close[0].length;
        if (depth === 0) { bodyEnd = lt; end = cursor; break; }
        continue;
      }
      const nested = INVOKE_AT.exec(peek);
      if (nested) { depth += 1; cursor = lt + nested[0].length; continue; }
      cursor = lt + 1;
    }
    if (bodyEnd < 0) { bodyEnd = s.length; end = s.length; }
    const { args, broken } = readParams(s.slice(0, bodyEnd), bodyStart, types?.[name]);
    if (broken) return null;
    calls.push({ name, arguments: JSON.stringify(args) });
    i = end;
    if (depth > 0 && end === s.length) break;
  }
  return calls.length ? { calls, end: i } : null;
}

/** GLM 风格：<tool_call>name<arg_key>k</arg_key><arg_value>v</arg_value></tool_call> */
function readGlmCall(s, start, types = null) {
  const head = /^\s*([A-Za-z_][\w.:-]*)\s*</.exec(s.slice(start, start + 160));
  if (!head) return null;
  const name = head[1];
  const args = {};
  let i = start + head[0].length - 1;
  let found = 0;
  for (let guard = 0; guard < 512; guard += 1) {
    const at = skipSpace(s, i);
    const keyOpen = ARG_KEY_AT.exec(s.slice(at, at + 32));
    if (!keyOpen) break;
    const keyBody = at + keyOpen[0].length;
    const keyClose = /<\s*\/\s*arg_key\s*>/i.exec(s.slice(keyBody, keyBody + MAX_TAG));
    if (!keyClose) break;
    const key = s.slice(keyBody, keyBody + keyClose.index).trim();
    if (!key) break;
    const valAt = skipSpace(s, keyBody + keyClose.index + keyClose[0].length);
    const valOpen = ARG_VALUE_AT.exec(s.slice(valAt, valAt + 32));
    if (!valOpen) break;
    const valBody = valAt + valOpen[0].length;
    const valClose = /<\s*\/\s*arg_value\s*>/i.exec(s.slice(valBody, valBody + MAX_HOLD));
    if (!valClose) break;
    args[key] = scalarValue(s.slice(valBody, valBody + valClose.index), types?.[name]?.[key]);
    i = valBody + valClose.index + valClose[0].length;
    found += 1;
  }
  return found ? { calls: [{ name, arguments: JSON.stringify(args) }], end: i } : null;
}

/**
 * 截断兜底：`[完整对象, 完整对象, 半个对象` 里把完整的那几个救回来。
 * 只救「参数本身完整」的元素，绝不补括号猜参数。
 */

/* --------------------------- 各类区块 --------------------------- */

function readTagBlock(s, start, ctx) {
  const gt = s.indexOf('>', start);
  if (gt < 0 || gt - start > MAX_TAG) return null;
  const bodyStart = skipSpace(s, gt + 1);
  let calls = null;
  let end = bodyStart;
  if (s.startsWith('```', bodyStart)) {
    // <tool_call>```json … ```</tool_call>：标记里又套了一层围栏
    const nl = s.indexOf('\n', bodyStart);
    if (nl < 0) return null;
    const rest = s.slice(nl + 1);
    const close = /(?:^|\n)[ \t]*```/.exec(rest);
    const bodyEnd = close ? nl + 1 + close.index : s.length;
    const inner = s.slice(nl + 1, bodyEnd);
    calls = parseJsonToolCalls(inner) || parseDsmlCalls(inner) || null;
    end = close ? nl + 1 + close.index + close[0].length : s.length;
  } else if (s[bodyStart] === '{' || s[bodyStart] === '[') {
    const ve = jsonValueEnd(s, bodyStart);
    if (ve > 0) {
      const payload = s.slice(bodyStart, ve);
      const inferred = inferMissingName(payload, ctx || {});
      calls = parseJsonToolCalls(payload)
        || parseDsmlCalls(payload)
        || readInvokeChain(payload, 0, ctx.argTypes)?.calls
        || (inferred ? [inferred] : null)
        || null;
      end = ve;
    } else if (s[bodyStart] === '{' || s[bodyStart] === '[') {
      return null;   // 截断的批次：一条都不执行
    }
  } else {
    const glm = readGlmCall(s, bodyStart, ctx.argTypes);
    const chain = glm || readInvokeChain(s, bodyStart, ctx.argTypes);
    if (chain) {
      calls = chain.calls;
      end = chain.end;
    } else {
      // <tool_call> 内嵌 XML 子标签（<id>/<name>/<arguments>{json}</arguments>）
      const xml = readXmlToolChildren(s, bodyStart);
      if (xml) {
        calls = xml.calls;
        end = xml.end;
      } else {
        // <tool_call>get_goal</tool_call>：只有工具名、没有参数（零参工具）
        const closeAt = s.indexOf('</', bodyStart);
        const bodyEnd = closeAt > 0 ? closeAt : s.length;
        const nameOnly = /^\s*([A-Za-z_][\w.:-]*)\s*$/.exec(s.slice(bodyStart, Math.min(bodyEnd, bodyStart + 128)));
        if (!nameOnly) return null;
        calls = [{ name: nameOnly[1], arguments: '{}' }];
        end = bodyEnd;
      }
    }
  }
  if (!calls?.length) return null;
  return closedAt(s, end, calls);
}

/** <tool_calls> 包装里套多个 XML 子标签形态的 <tool_call>：逐个解析。 */
function readWrapperXmlToolCalls(s, inner, bodyEnd, ctx) {
  const calls = [];
  let i = inner;
  while (i < bodyEnd) {
    if (s[i] === '<') {
      const open = matchOpener(s, i, { allowBareJson: false, allowFenced: false, lineStart: true });
      if (open && (open.kind === 'tag' || open.kind === 'invoke')) {
        const block = readBlock(s, i, open, ctx);
        if (block?.calls?.length) {
          calls.push(...block.calls);
          i = block.end;
          continue;
        }
      }
    }
    i += 1;
  }
  return calls.length ? calls : null;
}

function readWrapperBlock(s, start, ctx) {
  const gt = s.indexOf('>', start);
  if (gt < 0 || gt - start > MAX_TAG) return null;
  const inner = gt + 1;
  const closeRe = /<\s*\/\s*(?:[A-Za-z_][\w.-]*:)?function_calls\s*>/i;
  const rest = s.slice(inner);
  const close = closeRe.exec(rest);
  const bodyEnd = close ? inner + close.index : s.length;
  const body = s.slice(inner, bodyEnd);
  const calls = readInvokeChain(body, 0, ctx.argTypes)?.calls
    || parseJsonToolCalls(body)
    || parseDsmlCalls(body, { allowUnclosedWrapper: true })
    || readWrapperXmlToolCalls(s, inner, bodyEnd, ctx)
    || null;
  if (!calls?.length) return null;
  const end = close ? bodyEnd + close[0].length : s.length;
  return closedAt(s, end, calls, true);
}

function readInvokeBlock(s, start, ctx) {
  const chain = readInvokeChain(s, start, ctx.argTypes);
  if (!chain?.calls.length) return null;
  return { calls: chain.calls, end: consumeClosers(s, chain.end) };
}

function readDsmlBlock(s, start) {
  let depth = 0;
  let offset = start;
  let end = -1;
  let invokeName = null;
  let paramDepth = 0;
  let first = true;
  for (let guard = 0; guard < 1024; guard += 1) {
    const tag = scanDsmlTag(s, offset, {
      allowBareParameters: depth > 0,
      invokeName,
      allowInlineArguments: depth > 0 && paramDepth === 0,
    });
    if (process.env.DDBG) console.error('TAG', offset, JSON.stringify(tag));
    // 第一个标签就不成立的（例如正文里提到的 `<｜｜DSML｜｜ ...>`），不是区块
    if (!tag) { if (first) return null; break; }
    first = false;
    // 内联参数：name="arguments":{...}> —— JSON 本体写在标签里，用流式扫描器吃掉它。
    // scanDsmlTag 的 end 停在 JSON 开头，这里要推进到配平后的 '>'。
    if (tag.kind === 'inlineArguments') {
      const scanner = new DsmlInlineArguments();
      let j = tag.end;
      let closed = false;
      for (; j < s.length; j += 1) {
        if (scanner.accept(s[j])) { closed = true; break; }
        if (scanner.bad) break;
      }
      if (!closed) { if (first) return null; break; }
      offset = j + 1;
      // 它和普通 parameter 一样有对应的闭合标签，深度要照常记账
      depth += 1;
      paramDepth = 1;
      continue;
    }
    if (tag.kind === 'invoke') {
      invokeName = tag.closing ? null : (tag.attributes?.name || null);
      paramDepth = 0;
    }
    if (tag.kind === 'parameter' && invokeName) {
      paramDepth = Math.max(0, paramDepth + (tag.closing ? -1 : 1));
    }
    offset = tag.end;
    depth += tag.closing ? -1 : 1;
    if (depth <= 0) { end = offset; break; }
  }
  if (end < 0) end = s.length;
  const block = s.slice(start, end);
  const calls = parseDsmlCalls(block, { allowUnclosedWrapper: true });
  if (!calls?.length) return null;
  return closedAt(s, end, calls, true);
}

/**
 * 模型有时省掉 JSON 里的 name 字段（特别是只声明了一个工具时）。
 * 在无歧义的前提下推断工具名：恰好声明了一个工具，或者参数键集合
 * 只匹配到一个已声明工具的 schema。推断不出来就不猜。
 */
function inferMissingName(payload, ctx) {
  const trimmed = payload.trim();
  if (!trimmed || !/^[{[]/.test(trimmed)) return null;
  let parsed = null;
  try { parsed = JSON.parse(trimmed); } catch {
    const repaired = trimmed.replace(/\\(?![\\/"bfnrtu])/g, '\\\\');
    try { parsed = JSON.parse(repaired); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.name) return null;   // 有 name 却没被识别：别在这里抢
  const allowed = ctx.allowed;
  const keys = Object.keys(parsed);
  if (!keys.length) return null;
  const declared = Object.keys(ctx.argTypes || {});
  let candidates;
  if (declared.length) {
    candidates = declared.filter((tool) => {
      const names = Object.keys(ctx.argTypes[tool] || {});
      return keys.every((k) => names.includes(k));
    });
  } else {
    candidates = null;
  }
  if (allowed) candidates = (candidates || []).filter((tool) => allowed.has(tool));
  if (candidates && candidates.length !== 1) return null;
  if (!candidates) {
    // 没有 schema 信息时只在「恰好声明了一个工具」时推断
    if (!allowed || allowed.size !== 1) return null;
    candidates = [...allowed];
  }
  const json = (() => { try { return JSON.stringify(JSON.parse(trimmed)); } catch { return trimmed; } })();
  return { name: candidates[0], arguments: json };
}

function readJsonBlock(s, start, ctx) {
  const ve = jsonValueEnd(s, start);
  if (ve > 0) {
    const payload = s.slice(start, ve);
    const calls = parseJsonToolCalls(payload) || (() => {
      const inferred = inferMissingName(payload, ctx || {});
      return inferred ? [inferred] : null;
    })();
    if (!calls?.length) return null;
    return closedAt(s, ve, calls, true);
  }
  return null;   // 截断的 JSON：不执行也不猜
}

function readFenceBlock(s, start) {
  const bodyStart = s.indexOf('\n', start);
  if (bodyStart < 0) return null;
  const ticks = /^`{3,}/.exec(s.slice(start))?.[0].length || 3;
  // 只认 ``` 或 ```json 这两种头；```javascript 之类是代码示例
  const header = s.slice(start + ticks, bodyStart).trim().toLowerCase();
  if (header && header !== 'json') return null;
  const rest = s.slice(bodyStart + 1);
  // 闭合围栏必须自己独占一行，且反引号不少于开围栏
  const close = new RegExp('(?:^|\\n)[ \\t]*`{' + ticks + ',}[ \\t]*(?=\\n|$)').exec(rest);
  // 围栏没闭合就不认：半截围栏里的完整 JSON 不能执行
  if (!close) return null;
  const bodyEnd = bodyStart + 1 + close.index;
  const body = s.slice(bodyStart + 1, bodyEnd);
  // 围栏里只认显式的 {"tool_calls":[…]} 信封；普通对象/工具定义是示例数据
  let value;
  try { value = JSON.parse(body); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).length !== 1 || !Array.isArray(value.tool_calls) || !value.tool_calls.length) return null;
  const calls = parseJsonToolCalls(body);
  if (!calls?.length) return null;
  let end = bodyStart + 1 + close.index + close[0].length;
  // 闭合围栏那一行的换行也属于围栏本身：留着它会让后面的正文多出一个空行
  if (s.startsWith('\r\n', end)) end += 2; else if (s[end] === '\n') end += 1;
  return closedAt(s, end, calls, true);
}

/** 惰性围栏（未启用围栏协议）的结束位置：闭合 ``` 之后。 */
function fenceEnd(s, start) {
  const header = s.indexOf('\n', start);
  if (header < 0) return s.length;
  const rest = s.slice(header + 1);
  const close = /(?:^|\n)[ \t]*```/.exec(rest);
  if (!close) return s.length;
  return header + 1 + close.index + close[0].length;
}

/** 解析失败的区域整体跳过，避免在它内部重新扫出嵌套示例里的「调用」。 */
function skipFailedRegion(s, i, open) {
  switch (open.kind) {
    case 'json': {
      const end = jsonValueEnd(s, i);
      // 值没闭合：后面整段都可能是这个坏值的残体，不再往里扫
      return end > i ? end : s.length;
    }
    case 'fence':
    case 'inertFence':
      return Math.max(fenceEnd(s, i), i + 1);
    case 'tag':
    case 'wrapper': {
      const gt = s.indexOf('>', i);
      if (gt < 0) return i + 1;
      const body = skipSpace(s, gt + 1);
      if (s[body] === '{' || s[body] === '[') {
        const end = jsonValueEnd(s, body);
        // 未闭合的调用参数里出现 DSML 之类的标记，是残体，不是新调用
        return end > body ? end : s.length;
      }
      return gt + 1;
    }
    case 'dsml': {
      // 只有真正的 wrapper 开头才整段吸收（否则后面可能还有合法调用）；
      // 普通/非法 DSML 标记跳过它自己就够了。
      const gt = s.indexOf('>', i);
      const head = s.slice(i, gt > 0 ? gt : i + 64).toLowerCase();
      if (!/(?:calls|function_calls|tool_calls)\s*$/.test(head)) return gt > i ? gt + 1 : i + 1;
      const closeRe = new RegExp('<\\s*\\/\\s*' + PIPE + '{1,3}\\s*DSML' + PIPE + '*\\s*(?:calls|tool_calls|function_calls)\\s*>', 'i');
      const close = closeRe.exec(s.slice(i));
      return close ? i + close.index + close[0].length : s.length;
    }
    case 'invoke': {
      // 标记块解析不出来：跳过这个标签本身，别在里面逐字符重扫
      const gt = s.indexOf('>', i);
      return gt > i ? gt + 1 : i + 1;
    }
    default:
      return i + 1;
  }
}

function readBlock(s, i, open, ctx) {  switch (open.kind) {
    case 'dsml': return readDsmlBlock(s, i);
    case 'tag': return readTagBlock(s, i, ctx);
    case 'wrapper': return readWrapperBlock(s, i, ctx);
    case 'invoke': return readInvokeBlock(s, i, ctx);
    case 'json': return readJsonBlock(s, i);
    case 'fence': return readFenceBlock(s, i, ctx);
    default: return null;
  }
}

/* --------------------------- 校验 --------------------------- */

const NAME_OK = /^[A-Za-z0-9_.:-]{1,128}$/;
const ID_OK = /^[A-Za-z0-9_.:-]{1,256}$/;

/**
 * 解析 <tool_call> 内嵌 XML 子标签形态（qoder-intl 真实出现过的写法）：
 *   <tool_call>\n<id>call_x</id>\n<name>bash</name>\n<arguments>{json}</arguments>\n</tool_call>
 * arguments 子标签体是完整参数对象（应用孤立反斜杠修复）；其余子标签按标量参数收集。
 * JSON 修不好时把原文透传（lenientArguments），让工具执行端报错自愈。
 */
function readXmlToolChildren(s, start) {
  const fields = {};
  const params = {};
  let i = skipSpace(s, start);
  let sawChild = false;
  for (let guard = 0; guard < 64; guard += 1) {
    if (s[i] !== '<' || s[i + 1] === '/') break;
    const m = /^<([A-Za-z_][\w.:-]*)(?:\s[^>]*)?>/.exec(s.slice(i, i + 128));
    if (!m) break;
    const tag = m[1];
    const bodyStart = i + m[0].length;
    const closeRe = new RegExp('</\\s*' + tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*>', 'i');
    const close = closeRe.exec(s.slice(bodyStart, bodyStart + MAX_HOLD));
    if (!close) return null;
    const body = s.slice(bodyStart, bodyStart + close.index);
    sawChild = true;
    if (tag === 'id') {
      fields.id = body.trim();
    } else if (tag === 'name') {
      fields.name = body.trim();
    } else if (tag === 'arguments' || tag === 'parameters') {
      const trimmed = body.trim();
      let value = null;
      try { value = JSON.parse(trimmed); } catch {
        const repaired = trimmed.replace(/\\(?![\\/"bfnrtu])/g, '\\\\');
        try { value = JSON.parse(repaired); } catch { /* 修不好：原文透传 */ }
      }
      fields.arguments = value != null ? { json: JSON.stringify(value) } : { json: trimmed, lenient: true };
    } else if (tag === 'parameter' || tag === 'invoke' || tag === 'tool_call') {
      return null; // 别的方言，交给各自的处理器
    } else if (body.trim()) {
      params[tag] = scalarValue(body, null);
    }
    i = skipSpace(s, bodyStart + close.index + close[0].length);
  }
  if (!sawChild || !fields.name || !NAME_OK.test(fields.name)) return null;
  let argumentsText = '{}';
  let lenientArguments = false;
  if (fields.arguments) {
    argumentsText = fields.arguments.json;
    lenientArguments = fields.arguments.lenient === true;
  } else if (Object.keys(params).length) {
    argumentsText = JSON.stringify(params);
  }
  const call = { name: fields.name, arguments: argumentsText };
  if (lenientArguments) call.lenientArguments = true;
  if (fields.id && ID_OK.test(fields.id)) call.id = fields.id;
  return { calls: [call], end: i };
}

function normalizeCall(raw, allowed, issues) {
  if (!raw || typeof raw !== 'object') { issues.bad_name = (issues.bad_name || 0) + 1; return null; }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || !NAME_OK.test(name)) { issues.bad_name = (issues.bad_name || 0) + 1; return null; }
  if (allowed && !allowed.has(name)) { issues.unknown_tool = (issues.unknown_tool || 0) + 1; return null; }
  let argsText = raw.arguments;
  if (argsText == null || argsText === '') argsText = '{}';
  if (typeof argsText !== 'string') {
    try { argsText = JSON.stringify(argsText); } catch { issues.bad_arguments = (issues.bad_arguments || 0) + 1; return null; }
  }
  if (!argsText.trim()) argsText = '{}';
  if (raw.lenientArguments !== true) {
    let parsed;
    try { parsed = JSON.parse(argsText); } catch { issues.bad_arguments = (issues.bad_arguments || 0) + 1; return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      issues.bad_arguments = (issues.bad_arguments || 0) + 1;
      return null;
    }
  }
  // lenientArguments：模型把 arguments 的 JSON 转义写坏了，原文透传 ——
  // 工具执行端报错后模型自己修正，而不是丢掉整个调用漏标记给用户。
  const id = typeof raw.id === 'string' && ID_OK.test(raw.id) ? { id: raw.id } : {};
  return { ...id, name, arguments: argsText };
}

/* --------------------------- 主解析 --------------------------- */

/**
 * 解析一段完整文本里的工具调用。
 * @returns {{calls: Array, text: string, issues: object}}
 *   calls 每一项 {id?, name, arguments(JSON 字符串)}
 *   text  扣掉标记后的正文（标记之后的内容在出现调用时丢弃，模型自己编的结果不能回流）
 */
export function parseMarkup(input, { allowedNames = null, allowBareJson = true, allowFenced = false, argTypes = null, silent = false,
  keepTextAfterCalls = true, strictAfterCalls = false } = {}) {
  if (silent) quiet += 1;
  const s = String(input ?? '');
  const allowed = allowedNames == null ? null : new Set(allowedNames);
  const ctx = { argTypes, allowFenced, allowed };
  const issues = Object.create(null);
  const calls = [];
  let text = '';
  let sawCall = false;
  let lineStart = true;
  let inlineTicks = 0;
  let i = 0;
  let textFrom = 0;
  let callsEnd = 0;
  let lastClosed = false;
  let cutAt = -1;
  let lastGroup = false;

  while (i < s.length) {
    const ch = s[i];
    if (ch === '`') {
      const end = backtickRunEnd(s, i);
      const width = end - i;
      if (inlineTicks || width < 3) {
        if (!inlineTicks && sawCall && strictAfterCalls) {
          cutAt = i;
          if (keepTextAfterCalls) text += s.slice(textFrom, i).replace(/\s+$/, '');
          textFrom = s.length;
          break;
        }
        inlineTicks = inlineTicks === width ? 0 : inlineTicks || width;
        lineStart = false;
        i = end;
        continue;
      }
    }
    if (inlineTicks) {
      i += 1;
      continue;
    }
    // 调用之后遇到行首的「工具结果 / 下一轮角色」：本轮到此为止，后面是模型编的
    if (sawCall && lineStart && FABRICATED.test(s.slice(i, i + 40))) {
      cutAt = i;
      text += keepTextAfterCalls ? s.slice(textFrom, i) : "";
      textFrom = s.length;
      break;
    }
    // 悬空的闭合标签既不是调用也不是正文（只在已经确认这是工具轮之后才吞，
    // 否则会吃掉正文里被引用的 </tool_call> 字面量）
    if (ch === '<' && sawCall) {
      const closer = matchCloserAt(s, i);
      // 无斜杠的 <｜｜DSML｜｜ calls> 既可能是「上游漏掉斜杠的闭合」，也可能是
      // 下一个调用批次的开头。能当开头解读时优先当开头，否则会吃掉它的批次。
      // 带斜杠的（</call_call> 等）确定是闭合；只有不带斜杠的 DSML 包装才要再确认
      const slashCloser = /^<\s*\//.test(s.slice(i, i + 8));
      const alsoOpener = !slashCloser && closer && matchOpener(s, i, { allowBareJson, allowFenced, lineStart: false });
      if (closer && !alsoOpener) {
        if (!sawCall) text += s.slice(textFrom, i);
        textFrom = i + closer.length;
        bump('junk');
        i += closer.length;
        lineStart = false;
        continue;
      }
    }
    // 已经出过调用的地方，紧跟标记的裸 JSON 也当调用（上游常把闭标签和下一批
    // 调用写在同一行）；正文里的示例对象仍要求行首。
    const open = matchOpener(s, i, { allowBareJson, allowFenced, lineStart: lineStart || sawCall });
    if (!open) {
      const ch = s[i];
      // 严格模式：调用之后出现任何非空白正文，本轮就到此为止。
      // 落在标签内部（最近的 < 晚于最近的 >）时不算正文。
      const insideTag = s.lastIndexOf('<', i - 1) > s.lastIndexOf('>', i - 1);
      if (sawCall && strictAfterCalls && !insideTag && !/[\s>\/|｜∣│]/.test(ch)) {
        // 看起来还是标记开头（或半个标记）就先不切，交给后面的扫描处理
        const ahead = s.slice(i, i + 48);
        if (couldStartMark(s.slice(i, i + TAIL_LOOKBACK)) || /^<\/?[^>]{0,40}>/.test(ahead)) {
          i += 1;
          lineStart = false;
          continue;
        }
        cutAt = i;
        // 调用之后那一段空白也不外发（旧 ToolTurnGuard 的行为）
        text += keepTextAfterCalls ? s.slice(textFrom, i).replace(/\s+$/, '') : '';
        textFrom = s.length;
        break;
      }
      if (ch === '\n') lineStart = true;
      else if (ch !== ' ' && ch !== '\t' && ch !== '\r') lineStart = false;
      i += 1;
      continue;
    }
    const block = readBlock(s, i, open, ctx);
    if (open.kind === 'inertFence') {
      // 代码围栏整体跳过，作为普通正文
      i = fenceEnd(s, i);
      lineStart = false;
      continue;
    }
    if (!block?.calls?.length) {
      // 只有标签、没有内容（<seed:tool_call></seed:tool_call> 这种空标记）：
      // 整段丢掉。把它当正文吐回去，模型下一轮会照着自己写。
      if (open.kind !== 'json' && open.kind !== 'fence' && open.kind !== 'inertFence') {
        const gt = s.indexOf('>', i);
        const after = gt > 0 ? skipSpace(s, gt + 1) : -1;
        if (after > 0 && (after > gt + 1 || s[after] === '<')) {
          const end = consumeClosers(s, after);
          if (end > after) {
            if (!sawCall) { text += s.slice(textFrom, i); textFrom = end; }
            bump('dropped_text', end - i);
            i = end;
            lineStart = false;
            continue;
          }
        }
      }
      // 不是调用：整段当正文，但不进内部重扫 —— 否则
      // {"example":{"tool_calls":[…]}} 这种示例里的嵌套对象会被当成真调用
      bump('rejected_blocks');
      i = skipFailedRegion(s, i, open);
      lineStart = false;
      continue;
    }
    const accepted = [];
    for (const raw of block.calls) {
      const call = normalizeCall(raw, allowed, issues);
      // 并列的同名同参调用是真的并行调用（模型有时确实这么写），不去重
      if (call) accepted.push(call);
    }
    if (!accepted.length) {
      // 结构认出来了但调用不合法（未声明工具、参数不是对象）：整块丢掉。
      // 既不执行，也不让整轮失败，更不能把标记原文当正文吐回去 ——
      // 否则模型下一轮会照着自己上一次的输出继续写标记。
      // 例外：代码围栏是「示例数据」，原样保留当正文。
      bump('rejected_blocks');
      if (open.kind !== 'fence' && open.kind !== 'inertFence') {
        bump('dropped_text', Math.max(0, block.end - i));
        text += s.slice(textFrom, i);
        textFrom = block.end;
      }
      i = block.end;
      lineStart = false;
      continue;
    }
    if (sawCall) {
      if (keepTextAfterCalls) text += s.slice(textFrom, i);
      else bump('dropped_text', i - textFrom);
    } else text += s.slice(textFrom, i);
    calls.push(...accepted);
    sawCall = true;
    lastClosed = Boolean(block.closed);
    lastGroup = Boolean(block.group);
    i = block.end;
    textFrom = block.end;
    callsEnd = block.end;
    lineStart = false;
  }
  if (sawCall) {
    if (keepTextAfterCalls) {
      // 调用之后的尾巴：宽松通道原样保留（正文换行是模型的输出）；strict 通道
      // 本来就要丢掉这段，只把紧跟标记的那个换行也一并裁掉，避免多出空行。
      const raw = s.slice(textFrom);
      const tail = keepTextAfterCalls ? raw : raw.replace(/^[ \t]*\r?\n/, '');
      if (tail.trim()) text += tail; else bump('dropped_text', tail.length);
    } else bump('dropped_text', Math.max(0, s.length - textFrom));
  } else text += s.slice(textFrom);

  for (const [code, n] of Object.entries(issues)) bump(code, n);
  bump('blocks', calls.length);
  if (silent) quiet -= 1;
  // end = 最后一个被接受的调用的结束位置（不是 textFrom：跳过/丢弃的片段也会推进它）
  return { calls, text, issues, end: cutAt >= 0 ? cutAt : sawCall ? callsEnd : 0, closed: lastClosed, group: lastGroup };
}

/* --------------------------- 流式外壳 --------------------------- */

const EMPTY = Object.freeze({ text: '', calls: [] });

/**
 * 流式外壳：扣留到轮末再判定。
 *
 * mode = null   普通模式，正文立即外发（只有可能是半个标记的尾巴会压住）
 * mode = 'tag'  已看到工具标记，整段扣留到 flush
 * mode = 'json' 行首裸 JSON，值闭合即判定，避免正文里的对象拖住整轮
 * mode = 'fence' ``` 围栏，闭合即判定
 */
export class MarkupSink {
  constructor({ allowedNames = null, allowBareJson = true, allowFenced = false, argTypes = null, strictAfterCalls = false, maxHold = MAX_HOLD } = {}) {
    this.opts = { allowedNames, allowBareJson, allowFenced, argTypes, strictAfterCalls,
      keepTextAfterCalls: strictAfterCalls !== true };
    // 空名单 = 本轮不接文本协议，整段正文原样通过（solo 未开原生工具时用）
    this.disabled = Array.isArray(allowedNames) && allowedNames.length === 0;
    this.maxHold = maxHold;
    this.pending = '';
    this.held = '';
    this.mode = null;
    this.lineStart = true;
    this.inlineTicks = 0;
    this.calls = 0;
    this.ended = false;
    this.finished = false;
    this.afterBatch = false;
    this.probe = '';
    this.hadCall = false;
    this.issues = Object.create(null);
  }

  /** 是否正在扣留（供适配器判断「message_stop 是否真的可以收尾」）。 */
  get holding() { return this.mode !== null; }

  /**
   * 扣留的内容是否已经完整：已经能解析出调用，或者标记已经闭合。
   * 适配器据此决定 message_stop 时就地收尾，还是等一次完整快照补尾 ——
   * 判断错了会变成「等一个永远不来的事件」的挂死。
   */
  get complete() {
    if (!this.holding) return true;
    if (this.mode === 'inert') return false;
    const trial = parseMarkup(this.held, { ...this.opts, silent: true });
    if (!trial.calls.length) return false;
    if (this.mode !== 'tag') return true;
    // 标记块：除了「能解析出调用」还要求它真的收尾了。少写一个闭合标签时宁可
    // 等一次完整快照 —— 提前收尾会把快照里后续的并行调用切掉。
    if (!junkOnly(this.held.slice(trial.end))) return false;
    return trial.closed === true;
  }

  /**
   * 本轮已经被主动收尾：调用之后又出现了自然语言（模型在编工具结果或继续叙事）。
   * 适配器据此直接结束并关闭上游。
   * 注意：不包含「已经产出调用」——收尾原因要区分 upstream_done 和
   * tool_turn_boundary，调用数由适配器自己的 toolIdx 判断。
   */
  /** 本轮是否已经收尾（strict 通道在调用/自编结果之后就到为止）。 */
  get stopped() { return this.finished; }

  #overflow() {
    bump('overflow');
    const text = this.held;
    this.held = '';
    this.mode = null;
    this.pending = '';
    return { text, calls: [] };
  }

  /** 扣留内容是否以「组级闭合」收尾：那只是一批调用写完，不代表本轮结束。 */


  /**
   * 扣留内容是否已经可以判定（true = 就地解析并外发）。
   */
  #settled() {
    if (this.mode === 'json') {
      const end = jsonValueEnd(this.held, 0);
      if (end < 0) return false;
      // 值后面只允许空白和闭合标签；出现半个标记或别的正文时继续扣留
      return junkOnly(this.held.slice(end)) ? 'soft' : false;
    }
    if (this.mode === 'fence' || this.mode === 'inert') {
      // 闭合围栏必须独占一行；流式时还要等到行尾换行，才知道后面没有尾随文本
      const header = this.held.search(/\r?\n/);
      if (header < 0) return false;
      const ticks = /^`{3,}/.exec(this.held)?.[0].length || 3;
      const closeRe = new RegExp('(?:^|\n)[ \t]*`{' + ticks + ',}[ \t]*\r?\n');
      const close = closeRe.exec(this.held.slice(header + 1));
      if (!close) return false;
      // 围栏后面还有正文：strict 通道这一轮就到此为止
      const after = this.held.slice(header + 1 + close.index + close[0].length);
      const prose = !junkOnly(after);
      return this.opts.strictAfterCalls === true && prose ? 'hard' : 'soft';
    }
    if (this.mode === 'tag') {
      // 探针解析：关掉 strict 截断，只取结构化结果与调用结束位置。
      // 否则 strict 会把「第二个 invoke 的参数正文」当成调用后的散文。
      const trial = parseMarkup(this.held, { ...this.opts, silent: true, strictAfterCalls: false, keepTextAfterCalls: true });
      if (!trial.calls.length) return false;
      const rest = this.held.slice(trial.end).replace(/^\s+/, '');
      // 只剩空白：等下一片，可能还有并行的第二个调用
      if (rest === '') return trial.closed === true && trial.group === true ? 'soft' : false;
      // 只有出现「组级闭合」这种明确收尾信号，才把残留标签当结束
      if (GROUP_CLOSER.test(rest) && junkOnly(rest)) return 'soft';
      // 模型自编的工具结果 / 下一轮角色：一定收尾
      if (FABRICATED.test(rest)) return 'hard';
      // 后面还跟着新的调用块（并行调用）：继续等
      if (matchOpener(rest, 0, { ...this.opts, lineStart: true })) return false;
      // 正在写一个标记（半个标签、半个 DSML 标签、半个单词）：等它写完再判。
      // 这里必须先于「正文」判定，否则 `<｜｜DSML｜｜ invoke na` 这种半截
      // 标签会被当成正文，把后面的并行调用整批丢掉。上一段的闭合标签有时
      // 会把下一个标记的 '<' 一起吃掉，所以管道前缀也要算标记。
      if (/^[<|｜∣│]/.test(rest)) return false;
      if (couldStartMark(rest) || /^[A-Za-z0-9_:.\-|｜∣│\/]*$/.test(rest)) return false;
      // 解析停在标签内部（半个 DSML 标签）：那后面的不是正文
      const head = this.held.slice(0, trial.end);
      if (head.lastIndexOf('<') > head.lastIndexOf('>')) return false;
      // 普通正文：strict 通道到此为止（后面的调用/正文都不要了）；
      // 宽松通道继续扣留 —— 正文后面还可能有并列调用，提前 flush 会把
      // 调用之间的正文切碎。
      return this.opts.strictAfterCalls === true ? 'hard' : false;
    }
    return null;
  }


  push(delta) {
    let chunk = typeof delta === 'string' ? delta : '';
    if (!chunk) return EMPTY;
    if (this.disabled) return { text: chunk, calls: [], issues: [] };
    if (this.finished) return EMPTY;
    if (this.afterBatch) {
      // 一批调用刚收完：下一段究竟是并列调用还是正文，取决于它开头。流式下
      // 标记可能被切在任意位置（'<' / '｜' / '<｜｜DSML' …），所以先攒够再判定，
      // 不能拿单个字符就下结论。
      this.probe += chunk;
      const raw = this.probe;
      const rest = raw.replace(/^\s+/, '');
      if (!rest) return EMPTY;
      // 光是残留的闭合标签（</call_call> 之类）：下一轮的垃圾，直接吞掉
      const loneCloser = matchCloserAt(rest, 0);
      if (loneCloser && rest.trim().length === loneCloser.length) { this.probe = ''; return EMPTY; }
      if (matchOpener(rest, 0, { ...this.opts, lineStart: true })) {
        this.afterBatch = false;
        this.probe = '';
        chunk = raw;
      } else if (couldStartMark(rest) || /^[A-Za-z0-9_:.\-|｜∣│/]*$/.test(rest)
        || (/^[<`|｜∣│]/.test(rest) && !/[>\n]/.test(rest))) {
        // 还没写完（半个标记 / 半个单词）：继续等，但要有个上限
        if (rest.length > 64) { this.probe = ''; this.finished = true; }
        return EMPTY;
      } else if (this.opts.strictAfterCalls === true) {
        // strict 通道：一批调用之后只允许并列调用，正文一律丢掉
        this.probe = '';
        this.finished = true;
        return EMPTY;
      } else {
        // 宽松通道：正文继续当正文外发（原样，连前导空白一起）
        this.afterBatch = false;
        this.probe = '';
        chunk = raw;
      }
    }
    if (this.mode) {
      this.held += chunk;
      if (this.held.length > this.maxHold) return this.#overflow();
      const settle = this.#settled();
      if (settle) {
        // hard: 本轮到此为止（自编结果 / strict 通道的正文）
        // soft: 这一批写完了，但后面可能还有并列批次或正文
        if (settle === 'hard') this.finished = true;
        else if (this.mode !== 'inert') this.afterBatch = true;
        return this.flush();
      }
      return EMPTY;
    }
    const buf = this.pending + chunk;
    this.pending = '';
    let lineStart = this.lineStart;
    let inlineTicks = this.inlineTicks;
    let out = '';
    let scan = 0;
    let literalEnd = 0;
    let hit = -1;
    let hitLineStart = lineStart;
    for (let i = 0; i < buf.length;) {
      const ch = buf[i];
      if (ch === '`') {
        const end = backtickRunEnd(buf, i);
        const width = end - i;
        if (inlineTicks || width < 3) {
          if (end === buf.length) {
            // A delimiter can span deltas. Resolve its length before opening
            // or closing the code span, and never scan inside the span.
            this.pending = buf.slice(i);
            this.inlineTicks = inlineTicks;
            this.lineStart = lineStart;
            const text = out + buf.slice(scan, i);
            return text ? { text, calls: [] } : EMPTY;
          }
          inlineTicks = inlineTicks === width ? 0 : inlineTicks || width;
          lineStart = false;
          literalEnd = end;
          i = end;
          continue;
        }
      }
      if (inlineTicks) {
        i += 1;
        continue;
      }
      // 悬空闭合标签：吞掉，不外发（同样只在调用轮里）
      if (ch === '<' && this.calls > 0) {
        const closer = matchCloserAt(buf, i);
        if (closer) {
          out += buf.slice(scan, i);
          i += closer.length;
          scan = i;
          lineStart = false;
          continue;
        }
      }
      // 已经出过调用之后，行首的「工具结果/下一轮角色」就是本轮终点
      if (this.hadCall && lineStart && FABRICATED.test(buf.slice(i, i + 40))) {
        this.finished = true;
        const text = out + buf.slice(scan, i);
        this.pending = '';
        return text ? { text, calls: [] } : EMPTY;
      }
      if (matchOpener(buf, i, { ...this.opts, lineStart: lineStart || this.hadCall })) { hit = i; hitLineStart = lineStart; break; }
      if (ch === '\n') lineStart = true;
      else if (ch !== ' ' && ch !== '\t' && ch !== '\r') lineStart = false;
      i += 1;
    }
    if (hit < 0) {
      const rest = buf.slice(scan);
      // A completed code span was already classified. Do not reconsider a
      // tag inside it as a partial opener when the next delta arrives.
      const tail = buf.slice(Math.max(scan, literalEnd));
      const cut = inlineTicks ? rest.length : rest.length - tailHoldLength(tail);
      this.inlineTicks = inlineTicks;
      this.pending = rest.slice(cut);
      // 尾巴没有外发，行首状态要按残留尾巴重算
      let ls = false;
      for (const ch of this.pending) {
        if (ch === '\n') ls = true;
        else if (ch !== ' ' && ch !== '\t' && ch !== '\r') ls = false;
      }
      this.lineStart = this.pending ? ls : lineStart;
      const text = out + rest.slice(0, cut);
      return text ? { text, calls: [] } : EMPTY;
    }
    const open = matchOpener(buf, hit, { ...this.opts, lineStart: hitLineStart });
    this.held = buf.slice(hit);
    const kind = open?.kind || 'tag';
    this.mode = kind === 'tag' || kind === 'dsml' || kind === 'wrapper' || kind === 'invoke'
      ? 'tag' : kind === 'fence' ? 'fence' : kind === 'inertFence' ? 'inert' : 'json';
    this.lineStart = false;
    this.inlineTicks = 0;
    const head = out + buf.slice(scan, hit);
    // 裸 JSON / 围栏：值一闭合就判定；标记块判定为收尾时本轮直接结束
    const settle = this.#settled();
    if (settle) {
      if (settle === 'hard') this.finished = true;
      else if (this.mode !== 'inert') this.afterBatch = true;
      const done = this.flush();
      return { text: head + done.text, calls: done.calls };
    }
    return head ? { text: head, calls: [] } : EMPTY;
  }

  flush() {
    const out = { text: '', calls: [], issues: [] };
    if (this.disabled) return out;
    if (this.mode === 'inert') {
      // 惰性围栏：原样外发，不解析
      out.text = this.held;
      this.held = '';
      this.mode = null;
    } else if (this.mode) {
      const result = parseMarkup(this.held, this.opts);
      out.text = result.text;
      out.calls = result.calls;
      this.calls += result.calls.length;
      for (const [code, n] of Object.entries(result.issues)) this.issues[code] = (this.issues[code] || 0) + n;
      this.held = '';
      this.mode = null;
    }
    if (this.pending) {
      out.text += this.pending;
      this.pending = '';
    }
    // 批次之后还在观望的那段（可能是正文）：轮末要放出去，不能吞掉
    if (this.probe) {
      if (this.opts.strictAfterCalls !== true) out.text += this.probe;
      this.probe = '';
    }
    this.lineStart = true;
    this.inlineTicks = 0;
    this.ended = true;
    out.issues = Object.entries(this.issues).map(([code, count]) => ({ code, count }));
    stats.turns += 1;
    if (out.calls.length) { stats.calls += out.calls.length; this.hadCall = true; }
    // strict 通道：轮末一旦产出调用，这一轮就到此结束
    if (out.calls.length && this.opts.strictAfterCalls === true) this.finished = true;
    if (out.issues.length) stats.held_turns += 1;
    return out;
  }
}
