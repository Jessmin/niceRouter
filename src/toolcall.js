import { MarkupSink, parseMarkup } from './markup.js';
import { JsonToolStream } from './json-tool-stream.js';
import { DsmlStream } from './dsml-stream.js';
import { ToolTurnGuard } from './tool-turn-guard.js';

/**
 * 工具调用（function calling）转换层
 * ==================================================================
 * 背景：上游 Trae solo_agent 通道**原生支持** tools，但 req/resp 形态和 OpenAI 不同，
 * 网关之前完全没接这一层，于是：
 *   1. 客户端传的 tools 被丢掉 → 模型收不到函数签名；
 *   2. 上游回的 tool_calls 帧被丢掉（solo.js 只读 response / reasoning_content）；
 *   3. role:'tool' 的结果消息被当成非法角色直接过滤 → 第二轮必崩；
 *   4. 模型于是把原生工具标记 `<seed:tool_call>…</seed:tool_call>` 当正文吐出来，
 *      就是「回复里出现裸标签」的根因。
 *
 * 实测协议（2026-11-04，deepseek-v4.1-flash__max）：
 *
 *   请求 tools：  [{type:'function', function:{name, description, parameters: <JSON 字符串!>}}]
 *                 ↑ parameters 必须是字符串，传对象会 4001
 *                 ↑ 结构体名：LLMUtilsChatRequest.tools []*idecopilot.Tool
 *
 *   响应 tool_calls（output 事件的字段，增量）：
 *     {"index":0,"id":"call_xxx","type":"function",
 *      "function_call":{"name":"get_weather","arguments":"<片段>"}}
 *     ↑ arguments 是**增量**，要拼接；第一帧带 id+name，后续帧只有 arguments
 *     ↑ 键名是 function_call，不是 OpenAI 的 function
 *
 *   回灌消息：
 *     {role:'assistant', content:[], tool_calls:[{id,type:'function',function_call:{name,arguments}}]}
 *     {role:'tool', tool_call_id:'call_xxx', content:[{type:'text',text:'...'}]}
 *     ↑ 若 assistant.tool_calls 用 function 键，上游报
 *       "ToolCall read field 4 'FunctionCall' error: required field Name is not set"
 */

/* ------------------------------ 请求方向 ------------------------------ */

/** 把 OpenAI 的 function.parameters 转成上游要的 JSON 字符串 */
function paramsToString(p) {
  if (p == null) return '';
  if (typeof p === 'string') return p;
  try {
    return JSON.stringify(p);
  } catch {
    return '';
  }
}

/**
 * OpenAI tools -> Trae tools。
 * 只保留 type==='function' 的条目；旧版 `functions` 字段也认。
 */
export function toolsToUpstream(tools, legacyFunctions) {
  const out = [];
  const list = Array.isArray(tools) ? tools : [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const fn = t.type === 'function' || !t.type ? t.function : null;
    if (!fn || !fn.name) continue;
    const item = {
      type: 'function',
      function: {
        name: String(fn.name),
        description: String(fn.description || ''),
        parameters: paramsToString(fn.parameters),
      },
    };
    out.push(item);
  }
  const fns = Array.isArray(legacyFunctions) ? legacyFunctions : [];
  for (const fn of fns) {
    if (!fn || !fn.name) continue;
    out.push({
      type: 'function',
      function: {
        name: String(fn.name),
        description: String(fn.description || ''),
        parameters: paramsToString(fn.parameters),
      },
    });
  }
  return out;
}

/** 有没有真正可用的工具定义 */
export function hasTools(tools, legacyFunctions) {
  return toolsToUpstream(tools, legacyFunctions).length > 0;
}

/** 从 messages 里收集所有工具名（用于兜底矫正模型瞎编的函数名） */
export function toolNames(tools, legacyFunctions) {
  return toolsToUpstream(tools, legacyFunctions).map((t) => t.function.name);
}

/** tool_choice: 'none' 时不注入工具；指定函数名时给一句强提示 */
export function toolChoiceHint(toolChoice, names) {
  if (!toolChoice || toolChoice === 'auto') return '';
  if (toolChoice === 'none') return '';
  if (toolChoice === 'required' || toolChoice === 'any') {
    return '本轮必须调用一个工具，不要直接用自然语言回答。';
  }
  if (typeof toolChoice === 'object' && toolChoice.function?.name) {
    return `本轮必须调用工具 ${toolChoice.function.name}，不要直接用自然语言回答。`;
  }
  return names?.length ? '' : '';
}

/**
 * 给**不支持原生 tools**的通道（trae IDE / qoder CLI）用的文本协议。
 * 模型只要按这个格式输出，文本筛子就能还原成 tool_calls。
 */
export function toolsToPromptText(tools, legacyFunctions, toolChoice, { format } = {}) {
  if (toolChoice === 'none') return '';
  const list = toolsToUpstream(tools, legacyFunctions);
  if (!list.length) return '';
  const lines = list.map((t) => {
    const f = t.function;
    const params = f.parameters || '{}';
    return `- ${f.name}: ${f.description || '(无描述)'}\n  参数 JSON Schema: ${params}`;
  });
  const hint = toolChoiceHint(toolChoice, list.map((t) => t.function.name));
  const protocol = format === 'json' ? [
    '需要调用外部工具时，整条回复只输出一个 JSON 对象。不要添加 Markdown、XML 或解释。',
    '{"tool_calls":[{"name":"工具名","arguments":{"参数名":"参数值"}}]}',
    '多个独立调用放在 tool_calls 数组中。若无需工具，直接用正文回答。',
  ] : [
    '需要调用工具时，**只输出**下面这一行，不要加解释、不要加代码块：',
    '<tool_call>{"name":"工具名","arguments":{"参数名":"参数值"}}</tool_call>',
    '可以连续输出多个 <tool_call> 块表示并行调用。不需要调用工具时，正常用自然语言回答即可。',
  ];
  return [
    '[可用工具]',
    '你可以调用下面这些工具来获取信息或执行操作：',
    ...lines,
    '',
    ...protocol,
    '输出本轮所需的工具调用后立即结束，等待调用方下一轮提供真实工具结果，再继续分析。',
    '只有下一轮由调用方提供的工具结果才可信。不要生成 [工具结果]、<tool_result>/<result>、执行成功消息或后续 User:/Assistant: 对话。',
    hint ? `\n[强制要求] ${hint}` : '',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

/** Text-only transports can preserve received reasoning as quoted history. */
export function formatReasoningHistory(message) {
  const reasoning = message?.reasoning_content;
  return typeof reasoning === 'string' && reasoning ? `[assistant_reasoning] ${JSON.stringify(reasoning).replace(/</g, '\\u003c')}` : '';
}

/* ------------------------------ 响应方向 ------------------------------ */

/**
 * 流式 tool_calls 累加器。
 * 上游把一次调用拆成多帧：首帧有 id/name，后续帧只有 arguments 增量。
 */
export class ToolCallAssembler {
  constructor() {
    this.map = new Map(); // index -> {id, type, name, arguments}
    this.order = [];
  }

  push(delta) {
    if (!delta) return;
    const idx = Number.isInteger(delta.index) ? delta.index : 0;
    let slot = this.map.get(idx);
    if (!slot) {
      slot = { index: idx, id: '', type: 'function', name: '', arguments: '' };
      this.map.set(idx, slot);
      this.order.push(idx);
    }
    if (delta.id) slot.id = delta.id;
    if (delta.type) slot.type = delta.type;
    if (delta.name) slot.name = delta.name;
    if (typeof delta.arguments === 'string' && delta.arguments) slot.arguments += delta.arguments;
  }

  get size() {
    return this.order.length;
  }

  /** 输出 OpenAI 形态：[{id,type,function:{name,arguments}}]，空名/空参的丢弃 */
  toOpenAI(prefixId = 'call') {
    const out = [];
    for (const idx of this.order) {
      const s = this.map.get(idx);
      if (!s.name) continue;
      out.push({
        id: s.id || `${prefixId}_${idx}`,
        type: 'function',
        function: { name: s.name, arguments: s.arguments || '{}' },
      });
    }
    return out;
  }
}

/** 从工具定义里抽出「工具名 → {参数名: 类型}」，parameter 风格标记按它做类型还原。 */
export function toolArgTypes(tools, legacyFunctions) {
  const map = {};
  for (const item of toolsToUpstream(tools, legacyFunctions)) {
    let schema = item.function.parameters;
    if (typeof schema === 'string') {
      try { schema = JSON.parse(schema); } catch { schema = null; }
    }
    const props = schema && typeof schema === 'object' ? schema.properties : null;
    if (!props || typeof props !== 'object') continue;
    const entry = {};
    for (const [key, value] of Object.entries(props)) {
      const type = Array.isArray(value?.type) ? value.type[0] : value?.type;
      if (typeof type === 'string') entry[key] = type;
    }
    map[item.function.name] = entry;
  }
  return map;
}

/** Shared streaming parser: 统一工具标记引擎（见 src/markup.js）。
 *
 * 语义变化（2026-11-10）：
 *   旧实现逐字符解析、解析失败抛 502 终止整轮；新实现看到标记就整段扣留到轮末
 *   再做一次完整解析，解析不出调用就降级为正文。工具名必须已声明、参数必须是
 *   完整 JSON 对象这两条底线没有放宽，放宽的只有「拼写容错」和「失败的处置」。
 */
const USE_NEXT_ENGINE = process.env.GATEWAY_MARKUP !== 'legacy';

/** 旧引擎（默认）：逐字符解析 + 严格拒绝。稳定但每遇到新拼写就要打补丁。 */
class LegacyMarkupSieve {
  constructor({ allowedNames, strictAfterCalls = false, allowFencedToolCalls = false, allowQoderMixedClose = false } = {}) {
    this.allowedNames = allowedNames == null ? null : new Set(allowedNames);
    this.json = new JsonToolStream({ allowFencedToolCalls, allowQoderMixedClose });
    this.dsml = new DsmlStream();
    this.turn = new ToolTurnGuard({ strictAfterCalls });
    this.calls = [];
  }
  static parsePayload(payload) { return JsonToolStream.parsePayload(payload); }
  get stopped() { return this.turn.stopped; }
  get hasIncompleteFrame() {
    return Boolean(this.dsml.active || this.dsml.buffer || this.json.wrapper || this.json.json || this.json.tag
      || this.json.fence || this.json.fenceOpening);
  }
  consume(parts, final = false) {
    let text = '';
    const calls = [];
    const merge = (results) => {
      for (const result of results) {
        if (this.stopped) break;
        if (result.text) text += this.turn.pushText(result.text);
        if (!this.stopped && result.calls?.length) {
          if (this.allowedNames && result.calls.some(({ name }) => !this.allowedNames.has(name))) {
            throw Object.assign(new Error('上游返回了未声明的工具调用'), { code: 'upstream_unknown_tool', status: 502 });
          }
          text += this.turn.beforeCalls();
          calls.push(...result.calls);
        }
      }
    };
    for (const part of parts) {
      if (this.stopped) break;
      if (part.text != null) merge(this.json.push(part.text));
      else {
        if (part.literal === '</｜｜DSML｜｜ parameter>') {
          const completed = this.json.closeQoderMixedWrapper();
          if (completed) { merge(completed); continue; }
        }
        merge(this.json.flush({ preserveTextContext: true }));
        this.json.observeDsmlBoundary(part.literal);
        if (part.calls) merge([{ calls: part.calls }]);
        else merge([{ text: part.literal || '' }]);
      }
    }
    if (final) merge(this.json.flush());
    if (final) text += this.turn.finish();
    this.calls.push(...calls);
    return { text, calls };
  }
  push(chunk) {
    if (this.allowedNames?.size === 0) return { text: chunk || '', calls: [] };
    return this.stopped ? { text: '', calls: [] } : this.consume(this.dsml.push(chunk || ''));
  }
  flush() { return this.stopped || this.allowedNames?.size === 0 ? { text: '', calls: [] } : this.consume(this.dsml.flush(), true); }
}

/** 新引擎（GATEWAY_MARKUP=next 时启用，见 src/markup.js）。 */
class NextMarkupSieve {
  constructor({ allowedNames = null, tools, functions, allowBareJson = true,
    allowFenced = false, allowFencedToolCalls = false, argTypes = null, strictAfterCalls = false } = {}) {
    this.allowedNames = allowedNames == null ? null : new Set(allowedNames);
    this.sink = new MarkupSink({
      allowedNames: allowedNames == null ? null : [...allowedNames],
      allowBareJson,
      allowFenced: allowFenced === true || allowFencedToolCalls === true,
      argTypes: argTypes || toolArgTypes(tools, functions),
      strictAfterCalls: strictAfterCalls === true,
    });
    this.calls = [];
  }

  static parsePayload(payload) { return JsonToolStream.parsePayload(payload); }

  /** 本轮已经产出调用；此后正文不再外发（模型自编的工具结果不能回流）。 */
  get stopped() { return this.sink.stopped; }

  /** 是否还缺一段可能的标记尾巴（适配器据此判断 message_stop 能否真的收尾）。 */
  get hasIncompleteFrame() { return !this.sink.complete; }

  /** 本轮的解析记账，用于排查真实世界出现了哪些拼写。 */
  get issues() { return this.sink.issues; }

  push(chunk) {
    const out = this.sink.push(chunk || '');
    this.calls.push(...out.calls);
    return out;
  }

  flush() {
    const out = this.sink.flush();
    this.calls.push(...out.calls);
    return out;
  }

  /** 兼容旧的分段接口：{text}/{literal}/{calls} 依次喂入。 */
  consume(parts, final = false) {
    let text = '';
    const calls = [];
    for (const part of parts || []) {
      const chunk = typeof part === 'string' ? part : (part?.text ?? part?.literal ?? '');
      if (chunk) {
        const out = this.push(chunk);
        text += out.text;
        calls.push(...out.calls);
      }
      if (part?.calls?.length) {
        calls.push(...part.calls);
        this.calls.push(...part.calls);
      }
    }
    if (final) {
      const out = this.flush();
      text += out.text;
      calls.push(...out.calls);
    }
    return { text, calls };
  }
}

/**
 * 对外的统一入口：默认走旧引擎，通道可以用 `engine: 'next'` 单独切新引擎，
 * 也可以用 GATEWAY_MARKUP=next 全局切换。
 *
 * 这里刻意用组合而不是「构造函数返回另一个类的实例」：后者会破坏
 * instanceof、原型替换（诊断脚本会临时替换 push/flush）这类常规类语义。
 */
export class ToolMarkupSieve {
  constructor(options = {}) {
    // 默认新引擎；engine:'legacy' 或 GATEWAY_MARKUP=legacy 可整体退回旧实现。
    const wantNext = options.engine === 'next' || (options.engine == null && USE_NEXT_ENGINE);
    const Impl = wantNext ? NextMarkupSieve : LegacyMarkupSieve;
    this.engine = new Impl(options);
    this.engineName = wantNext ? 'next' : 'legacy';
  }

  static parsePayload(payload) { return JsonToolStream.parsePayload(payload); }

  /** 本轮已经产出调用。 */
  get calls() { return this.engine.calls; }

  /** 本轮已经产出调用，后续正文不再外发。 */
  get stopped() { return this.engine.stopped; }

  /** 是否还缺一段可能的标记尾巴（适配器据此判断 message_stop 能否真的收尾）。 */
  get hasIncompleteFrame() { return this.engine.hasIncompleteFrame; }

  /** 解析记账（新引擎才有，旧引擎返回 undefined）。 */
  get issues() { return this.engine.issues; }

  push(chunk) { return this.engine.push(chunk); }

  flush() { return this.engine.flush(); }

  /** 兼容旧的分段接口：{text}/{literal}/{calls} 依次喂入。 */
  consume(parts, final = false) { return this.engine.consume(parts, final); }
}

/** 一段完整文本里的工具标记 → {text, calls}（非流式用） */
export function extractToolMarkup(text, options = {}) {
  const sieve = new ToolMarkupSieve(options);
  const a = sieve.push(text || '');
  const b = sieve.flush();
  return { text: a.text + b.text, calls: [...a.calls, ...b.calls] };
}

/** 新引擎的解析入口（tests/tools 用）。 */
export { parseMarkup };
