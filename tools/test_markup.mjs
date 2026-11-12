/**
 * 工具标记引擎回归（离线，零真实模型、零工具执行）
 * ==================================================================
 * 验证目标只有一个：**同一段模型输出，无论被切成什么样的流式分帧，结果必须
 * 完全一致，且必须只还原出模型真正写下的调用**。
 *
 * 覆盖：
 *   1. 32 个真实 DSH 工具签名 × 16 种已知方言 = 512 条样本；
 *   2. 每条样本在每个可能的分割点各回放一次（含单点切分与随机多点切分）；
 *   3. 负样本：截断、未声明工具、非对象参数、JSON Schema 数据、围栏示例、
 *      悬空闭合、正文引用 —— 一条都不许变成可执行调用；
 *   4. 任意垃圾输入都不许抛错（抛错=整轮 502，这是历史不稳定性的主因）。
 *
 * 用法：node tools/test_markup.mjs
 */
import assert from 'node:assert/strict';
import { parseMarkup, MarkupSink } from '../src/markup.js';

let pass = 0;
let fail = 0;
const ok = (name, fn) => {
  try { fn(); pass += 1; } catch (e) { fail += 1; console.log(`  ✗ ${name}\n    ${e.message}`); }
};

/* ------------------------- 真实工具签名 ------------------------- */
// 取自 DSH 实际请求的 32 个工具（只保留名字与参数类型，不含任何会话内容）。
const TOOLS = [
  ['ask_user_question', { questions: 'array' }],
  ['bash', { description: 'string', command: 'string', timeoutMs: 'number', workdir: 'string', run_in_background: 'boolean' }],
  ['create_goal', { objective: 'string', max_goal_rounds: 'number' }],
  ['edit', { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean' }],
  ['get_goal', {}],
  ['glob', { pattern: 'string', path: 'string' }],
  ['grep', { pattern: 'string', path: 'string', include: 'string' }],
  ['interrupt_agent', { agent_id: 'string' }],
  ['job_kill', { job_id: 'string', reason: 'string' }],
  ['job_list', {}],
  ['job_output', { job_id: 'string', wait: 'boolean', timeout_ms: 'number' }],
  ['list_agents', { scope: 'string' }],
  ['list_subagent_models', { provider: 'string', model: 'string' }],
  ['load_workspace_dependencies', {}],
  ['plugin_manager', { action: 'string', target: 'string', enabled: 'boolean', offset: 'number', limit: 'number' }],
  ['present', { files: 'array' }],
  ['read', { file_path: 'string', offset: 'number', limit: 'number' }],
  ['read_image', { file_path: 'string' }],
  ['schedule_create', { title: 'string', prompt: 'string', rrule: 'string', target: 'string' }],
  ['schedule_edit', { id: 'string', action: 'string', active: 'boolean', expectedUpdatedAt: 'string' }],
  ['schedule_list', { active: 'boolean', limit: 'integer', offset: 'integer' }],
  ['schedule_view', { id: 'string' }],
  ['send_message', { agent_id: 'string', message: 'string' }],
  ['skill', { name: 'string' }],
  ['subagent', { cwd: 'string', description: 'string', prompt: 'string', provider: 'string', model: 'string' }],
  ['subagent_fork', { cwd: 'string', description: 'string', prompt: 'string' }],
  ['todo_write', { todos: 'array' }],
  ['update_goal', { goal_id: 'string', revision: 'number', action: 'string', objective: 'string' }],
  ['web_fetch', { url: 'string' }],
  ['workflow', { script: 'string', meta: 'object', args: 'object' }],
  ['working_directory', { cd: 'string' }],
  ['write', { file_path: 'string', content: 'string' }],
];

const STRINGS = {
  file_path: 'src/server.js',
  command: 'npm test --silent',
  description: 'run the test suite',
  pattern: 'src/**/*.js',
  path: 'src',
  include: '*.mjs',
  url: 'https://example.com/a?b=1',
  content: 'line one\nline two\twith tab',
  old_string: 'const a = 1;',
  new_string: 'const a = 2;',
  objective: 'ship the stability work',
  prompt: 'continue the task',
  rrule: 'FREQ=DAILY;BYHOUR=9',
  target: 'default',
  message: 'hello there',
  reason: 'no longer needed',
  action: 'enable',
  name: 'review',
  provider: 'solo',
  model: 'deepseek-v4.1-flash',
  scope: 'all',
  agent_id: 'agent-1234',
  job_id: 'job-77',
  id: 'sched-9',
  title: 'daily report',
  cwd: '/work/repo',
  script: 'await run()',
  cd: 'src',
  expectedUpdatedAt: '2026-11-10T00:00:00Z',
};

function valueFor(key, type) {
  if (type === 'string') return STRINGS[key] ?? `value-${key}`;
  if (type === 'number' || type === 'integer') return key.startsWith('timeout') || key.includes('_ms') ? 5000 : 42;
  if (type === 'boolean') return true;
  if (type === 'array') return ['a.js', 'b.js'];
  if (type === 'object') return { kind: 'demo', count: 2 };
  return 'x';
}

function argsFor(props) {
  const args = {};
  for (const [key, type] of Object.entries(props)) args[key] = valueFor(key, type);
  return args;
}

/* ------------------------- 方言渲染 ------------------------- */

const json = (value) => JSON.stringify(value);
const xmlText = (value) => String(value);

function paramArgs(args, typeOf) {
  // parameter 风格只能承载文本，非字符串按 schema 类型序列化成 JSON 文本
  return Object.entries(args).map(([key, value]) => {
    const type = typeOf[key];
    const text = typeof value === 'string' ? value : json(value);
    const attr = type === 'string' || type == null ? '' : ' string="false"';
    return { key, text, attr, typed: type !== 'string' && type != null };
  });
}

function glmArgs(args) {
  return Object.entries(args).map(([key, value]) => `<arg_key>${key}</arg_key><arg_value>${typeof value === 'string' ? value : json(value)}</arg_value>`).join('');
}

const DIALECTS = {
  canonical: (name, args) => `<tool_call>${json({ name, arguments: args })}</tool_call>`,
  canonical_noclose: (name, args) => `<tool_call>${json({ name, arguments: args })}`,
  call_call_alias: (name, args) => `<call_call>${json({ name, arguments: args })}</call_call>`,
  seed_native: (name, args) => `<seed:tool_call>${json({ name, arguments: args })}</seed:tool_call>`,
  mixed_dsml_param_close: (name, args) => `<tool_call>${json({ name, arguments: args })}</｜｜DSML｜｜ parameter>`,
  mixed_dsml_full_tail: (name, args) => `<tool_call>${json({ name, arguments: args })}</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>`,
  mixed_inline_newline: (name, args) => `<tool_call>\n${json({ name, arguments: args })}\n</tool_call>`,
  args_as_json_string: (name, args) => `<tool_call>${json({ name, arguments: json(args) })}</tool_call>`,
  tool_calls_array: (name, args) => `<tool_calls>[${json({ name, arguments: args })}]</tool_calls>`,
  claude_wrapper: (name, args, typeOf) => `<function_calls><invoke name="${name}">${paramArgs(args, typeOf).map((p) => `<parameter name="${p.key}">${p.text}</parameter>`).join('')}</invoke></function_calls>`,
  minimax_wrapper: (name, args, typeOf) => `<minimax:tool_call><invoke name="${name}">${paramArgs(args, typeOf).map((p) => `<parameter name="${p.key}">${p.text}</parameter>`).join('')}</invoke></minimax:tool_call>`,
  plain_invoke: (name, args, typeOf) => `<invoke name="${name}">${paramArgs(args, typeOf).map((p) => `<parameter name="${p.key}">${p.text}</parameter>`).join('')}</invoke>`,
  dsml_single_pipe: (name, args, typeOf) => `<|DSML|invoke name="${name}">${paramArgs(args, typeOf).map((p) => `<|DSML|parameter name="${p.key}"${p.attr}>${p.text}</|DSML|parameter>`).join('')}</|DSML|invoke>`,
  dsml_double_pipe: (name, args, typeOf) => `<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="${name}">\n${paramArgs(args, typeOf).map((p) => `<｜｜DSML｜｜parameter name="${p.key}"${p.attr}>${p.text}</｜｜DSML｜｜parameter>`).join('\n')}\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>`,
  glm_arg_pairs: (name, args) => `<tool_call>${name}${glmArgs(args)}</tool_call>`,
  bare_json_envelope: (name, args) => `{"tool_calls":[${json({ name, arguments: args })}]}`,
  fenced_envelope: (name, args) => '```json\n' + `{"tool_calls":[${json({ name, arguments: args })}]}` + '\n```',
};

const SAMPLE_PREFIX = '我先检查一下环境。\n';

/* ------------------------- 回放工具 ------------------------- */

function replay(text, opts, splits) {
  const sink = new MarkupSink(opts);
  let out = '';
  const calls = [];
  let prev = 0;
  for (const at of splits) {
    const part = sink.push(text.slice(prev, at));
    out += part.text;
    calls.push(...part.calls);
    prev = at;
  }
  const last = sink.push(text.slice(prev));
  out += last.text;
  calls.push(...last.calls);
  const tail = sink.flush();
  return { text: out + tail.text, calls: calls.concat(tail.calls) };
}

function assertCalls(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: 调用数量 ${actual.length} != ${expected.length}`);
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(actual[i].name, expected[i].name, `${label}: 第${i}个工具名不符`);
    assert.deepEqual(JSON.parse(actual[i].arguments), expected[i].arguments, `${label}: 第${i}个参数不符`);
  }
}

function sampleSplits(length) {
  const points = new Set();
  for (let k = 1; k < length; k += 1) points.add(k);
  return [...points].map((k) => [k]);
}

function randomSplits(length, rng) {
  const count = 1 + Math.floor(rng() * 4);
  const points = new Set();
  for (let i = 0; i < count; i += 1) points.add(1 + Math.floor(rng() * (length - 1)));
  return [...points].sort((a, b) => a - b);
}

/** 确定性伪随机，保证失败可复现 */
function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/* ------------------------- 主矩阵 ------------------------- */

console.log('32 工具 × 16 方言 × 全部分割点');

const names = TOOLS.map(([name]) => name);
const optionSet = { allowedNames: names, argTypes: Object.fromEntries(TOOLS) };

let opts = optionSet;
let samples = 0;
let replays = 0;
const started = Date.now();

for (const [name, props] of TOOLS) {
  const args = argsFor(props);
  const typeOf = props;
  for (const [dialect, render] of Object.entries(DIALECTS)) {
    const body = render(name, args, typeOf);
    opts = dialect === 'fenced_envelope' ? { ...optionSet, allowFenced: true } : optionSet;
    const text = SAMPLE_PREFIX + body;
    const expected = [{ name, arguments: args }];
    const label = `${name}/${dialect}`;
    samples += 1;
    const rng = makeRng(samples * 7919);
    const variants = sampleSplits(text.length);
    for (let i = 0; i < variants.length; i += 1) {
      const result = replay(text, opts, variants[i]);
      assertCalls(result.calls, expected, `${label} split@${variants[i][0]}`);
      assert.equal(result.text, SAMPLE_PREFIX, `${label} split@${variants[i][0]}: 正文被改写`);
      replays += 1;
    }
    for (let i = 0; i < 12; i += 1) {
      const splits = randomSplits(text.length, rng);
      const result = replay(text, opts, splits);
      assertCalls(result.calls, expected, `${label} multi${splits.join(',')}`);
      assert.equal(result.text, SAMPLE_PREFIX, `${label} multi: 正文被改写`);
      replays += 1;
    }
    // 单块直达也必须一致
    const single = replay(text, opts, []);
    assertCalls(single.calls, expected, `${label} whole`);
    replays += 1;
  }
}

opts = optionSet;
console.log(`  ${samples} 条样本 / ${replays} 次分帧回放，用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);
pass += 1;

/* ------------------------- 并行调用 ------------------------- */

console.log('并行多调用');

const twoCallSets = [
  ['canonical', (a, b) => `<tool_call>${json(a)}</tool_call>\n<tool_call>${json(b)}</tool_call>`],
  ['tool_calls_array', (a, b) => `<tool_calls>[${json(a)},${json(b)}]</tool_calls>`],
  ['dsml_two_invoke', (a, b) => `<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="${a.name}">\n<｜｜DSML｜｜parameter name="command" string="true">${a.arguments.command}</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="description" string="true">${a.arguments.description}</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n<｜｜DSML｜｜invoke name="${b.name}">\n<｜｜DSML｜｜parameter name="file_path" string="true">${b.arguments.file_path}</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>`],
  ['claude_two', (a, b) => `<function_calls><invoke name="${a.name}"><parameter name="command">${a.arguments.command}</parameter><parameter name="description">${a.arguments.description}</parameter></invoke><invoke name="${b.name}"><parameter name="file_path">${b.arguments.file_path}</parameter></invoke></function_calls>`],
];

for (const [dialect, render] of twoCallSets) {
  const a = { name: 'bash', arguments: { command: 'ls -la', description: 'list files' } };
  const b = { name: 'read', arguments: { file_path: 'src/a.js' } };
  const text = render(a, b);
  const expected = [a, b];
  ok(`${dialect} 双调用全分割点`, () => {
    for (const splits of sampleSplits(text.length)) {
      const result = replay(text, opts, splits);
      assertCalls(result.calls, expected, `${dialect} split@${splits[0]}`);
      assert.equal(result.text.trim(), '', `${dialect}: 调用之间不应残留正文`);
    }
  });
}

/* ------------------------- 负样本 ------------------------- */

console.log('负样本：绝不执行不该执行的东西');

const NEGATIVE = [
  ['截断的单个参数对象', '<tool_call>{"name":"bash","arguments":{"command":"rm -rf /tmp/x', 0],
  ['截断在工具名中间', '<tool_call>{"name":"ba', 0],
  ['参数是数组', '<tool_call>{"name":"bash","arguments":[1,2]}</tool_call>', 0],
  ['参数是字符串', '<tool_call>{"name":"bash","arguments":"ls"}</tool_call>', 0],
  ['未声明的工具', '<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>', 0],
  ['名字带空白', '<tool_call>{"name":"bash rm","arguments":{}}</tool_call>', 0],
  ['行首 JSON Schema 数据', '{"type":"object","properties":{"a":{"type":"string"}}}', 0],
  ['行首裸 JSON 不是调用', '{"count":42}', 0],
  ['围栏里的示例（未启用围栏协议）', '```json\n{"tool_calls":[{"name":"bash","arguments":{"command":"ls"}}]}\n```', 0],
  ['悬空闭合', '</tool_call></tool_calls>', 0],
  ['只有开标签', '<tool_call>', 0],
  ['DSML 只有参数闭合', '</｜｜DSML｜｜parameter>', 0],
  ['名字在参数之后但参数残缺', '<invoke name="bash"><parameter name="command">ls', 0],
  ['空参数对象的合法调用', '<tool_call>{"name":"get_goal","arguments":{}}</tool_call>', 1],
];

for (const [label, text, expected] of NEGATIVE) {
  ok(`负样本 ${label}`, () => {
    const result = parseMarkup(text, optionSet);
    assert.equal(result.calls.length, expected, `${label}: 期望 ${expected} 个调用，实得 ${result.calls.length}`);
    for (const splits of sampleSplits(text.length)) {
      const streamed = replay(text, opts, splits);
      assert.equal(streamed.calls.length, expected, `${label} split@${splits[0]}: 分帧后行为不一致`);
    }
  });
}

ok('引用说明里的标记不会被当成调用参数执行', () => {
  const text = '说明：模型可以写 <tool_call> 来表示调用，但这一行是文档，不是调用。';
  const result = parseMarkup(text, optionSet);
  assert.equal(result.calls.length, 0);
  assert.match(result.text, /文档/);
});

ok('DSH 续接回复中的行内代码保留工具示例原文', () => {
  const call = '<tool_call>{"name":"read","arguments":{"file_path":"alpha.txt"}}</tool_call>';
  for (const quoted of ['`' + call + '`', '`` `` ``' + call + '``', '``\n' + call + '\n``']) {
    const source = 'ALPHA-61F9 BETA-27CE\n\n' + quoted;
    assert.deepEqual(parseMarkup(source, optionSet).calls, []);
    for (const splits of sampleSplits(source.length)) {
      const streamed = replay(source, opts, splits);
      assert.deepEqual(streamed.calls, []);
      assert.equal(streamed.text, source);
    }
    const withCall = source + '\n' + call;
    for (const splits of sampleSplits(withCall.length)) {
      const streamed = replay(withCall, opts, splits);
      assertCalls(streamed.calls, [{ name: 'read', arguments: { file_path: 'alpha.txt' } }], '工具示例之后的真实调用');
      assert.equal(streamed.text, source + '\n');
    }
  }
});

ok('工具结果伪造不回流：调用之后的正文被丢弃', () => {
  const text = '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>\n[工具结果] 执行成功，共 12 个文件。\n下一步继续。';
  const result = parseMarkup(text, optionSet);
  assert.equal(result.calls.length, 1);
  assert.equal(result.text.trim(), '');
});

ok('调用之前的正文完整保留', () => {
  const text = '先看一下目录结构。\n\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>';
  const result = parseMarkup(text, optionSet);
  assert.equal(result.text, '先看一下目录结构。\n\n');
});

ok('截断的调用批次一条都不执行', () => {
  // 半截批次不能猜：执行其中一条会让调用方拿到不一致的批次，宁可让客户端重试
  const text = '<tool_calls>[{"name":"bash","arguments":{"command":"ls"}},{"name":"read","arguments":{"file_p';
  const result = parseMarkup(text, optionSet);
  assert.equal(result.calls.length, 0);
});

/* ------------------------- 鲁棒性 ------------------------- */

console.log('鲁棒性：任何输入都不许抛错');

const GARBAGE = [
  '<', '<<<', '<tool_call', '<｜', '<｜｜DSML', '```', '```json\n{"tool_calls":[{',
  '{"name":', '{"name":"bash","arguments":{', '</｜｜DSML｜｜', '\u0000<\u0000',
  '<tool_call>'.repeat(50), '<invoke name="">', '<parameter name="a">',
  '{"tool_calls":[]}', '<tool_calls></tool_calls>', '<function_calls>',
];

ok('垃圾输入不抛错', () => {
  for (const text of GARBAGE) {
    parseMarkup(text, optionSet);
    replay(text, optionSet, [Math.floor(text.length / 2)]);
  }
});

ok('超长正文不含标记时原样保留', () => {
  const body = '普通文本，没有任何标记。\n'.repeat(2000);
  const result = parseMarkup(body, optionSet);
  assert.equal(result.calls.length, 0);
  assert.equal(result.text.length, body.length);
});

console.log('');
console.log(`结论：${pass} 组通过，${fail} 组失败，样本 ${samples}，回放 ${replays} 次。`);
if (fail) process.exitCode = 1;
