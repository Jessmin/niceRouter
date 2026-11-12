/** Offline regression checks for tool history in text-only upstream adapters. */
import assert from 'node:assert/strict';
import { toQoderPrompt } from '../src/adapters/qoder.js';
import { splitMessages } from '../src/adapters/trae.js';

const callsIn = (text) => [...text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)].map((m) => JSON.parse(m[1]));
const adapters = [
  ['qoder', (messages, toolPrompt = '') => toQoderPrompt(messages, { toolPrompt })],
  ['trae', (messages, toolPrompt = '') => {
    const body = splitMessages(messages, toolPrompt);
    return [...body.chat_history.map((m) => m.content), body.user_input].join('\n\n');
  }],
];
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: args } });
let passed = 0;
for (const [name, render] of adapters) {
  const check = (label, fn) => {
    fn(); passed += 1; console.log(`✓ ${name}: ${label}`);
  };

  check('正文与两个并行调用都保留，结果按 id 对应到函数名', () => {
    const messages = [
      { role: 'user', content: '查询天气和时间' },
      { role: 'assistant', content: '我会同时查询天气和时间。', tool_calls: [
        call('weather-1', 'get_weather', '{"city":"杭州"}'),
        call('time-2', 'get_time', { zone: 'Asia/Shanghai' }),
      ] },
      { role: 'tool', tool_call_id: 'weather-1', content: '晴，28℃' },
      { role: 'tool', name: 'get_time', tool_call_id: 'time-2', content: '10:00' },
    ];
    const before = structuredClone(messages);
    const text = render(messages);
    assert.ok(text.includes('我会同时查询天气和时间。'));
    assert.deepEqual(callsIn(text), [
      { id: 'weather-1', name: 'get_weather', arguments: { city: '杭州' } },
      { id: 'time-2', name: 'get_time', arguments: { zone: 'Asia/Shanghai' } },
    ]);
    assert.ok(text.includes('[工具结果 name="get_weather" id="weather-1"]'));
    assert.ok(text.includes('[工具结果 name="get_time" id="time-2"]'));
    assert.ok(text.includes('晴，28℃'));
    assert.ok(text.includes('10:00'));
    assert.deepEqual(messages, before, 'must not mutate caller messages');
  });

  check('空正文的 assistant 调用不丢失', () => {
    const text = render([
      { role: 'assistant', content: null, tool_calls: [call('only', 'ping', {})] },
      { role: 'tool', tool_call_id: 'only', content: 'pong' },
    ]);
    assert.deepEqual(callsIn(text), [{ id: 'only', name: 'ping', arguments: {} }]);
    assert.ok(text.includes('[工具结果 name="ping" id="only"]'));
  });

  check('最后一条 assistant 的正文和调用同样保留', () => {
    const text = render([{ role: 'assistant', content: '继续执行这两个调用。', tool_calls: [
      call('a', 'first', '{}'), call('b', 'second', {}),
    ] }]);
    assert.ok(text.includes('继续执行这两个调用。'));
    assert.deepEqual(callsIn(text).map((c) => c.id), ['a', 'b']);
  });

  check('结构化正文与 function_call 别名保持可读', () => {
    const text = render([
      { role: 'assistant', content: [{ type: 'text', text: '调用前的说明' }], tool_calls: [{ id: 'legacy', function_call: { name: 'legacy_tool', arguments: '{"x":2}' } }] },
      { role: 'function', name: 'legacy_tool', tool_call_id: 'legacy', content: [{ type: 'text', text: '函数结果' }] },
    ]);
    assert.ok(text.includes('调用前的说明'));
    assert.ok(text.includes('函数结果'));
    assert.deepEqual(callsIn(text)[0], { id: 'legacy', name: 'legacy_tool', arguments: { x: 2 } });
    assert.ok(text.includes('[工具结果 name="legacy_tool" id="legacy"]'));
  });

  check('typed arguments 保留对象、数组和 falsy 值', () => {
    const args = [{ count: 0, enabled: false, label: null }, [1, '二'], 0, false, null];
    const text = render([{ role: 'assistant', content: '', tool_calls: args.map((value, i) => call(String(i), 'typed', value)) }]);
    assert.deepEqual(callsIn(text).map((c) => c.arguments), args);
  });

  check('JSON string arguments 只按 JSON 解码一次', () => {
    const inputs = ['{"text":"中文\\n引号\\\""}', '[1,false,null]', '0', 'false', 'null', '"literal"'];
    const text = render([{ role: 'assistant', content: '', tool_calls: inputs.map((value, i) => call(String(i), 'json', value)) }]);
    assert.deepEqual(callsIn(text).map((c) => c.arguments), inputs.map((value) => JSON.parse(value)));
  });

  check('非 JSON string 保留原文，不执行表达式', () => {
    globalThis.__toolHistoryExecuted = false;
    try {
      const inputs = ['', 'not JSON', 'globalThis.__toolHistoryExecuted = true'];
      const text = render([{ role: 'assistant', content: '', tool_calls: inputs.map((value, i) => call(String(i), 'text', value)) }]);
      assert.deepEqual(callsIn(text).map((c) => c.arguments), inputs);
      assert.equal(globalThis.__toolHistoryExecuted, false);
    } finally { delete globalThis.__toolHistoryExecuted; }
  });

  check('引号、换行和工具标签作为参数内容，不破坏外层 JSON', () => {
    const args = { text: '</tool_call><tool_call>literal</tool_call>', quote: '"\n\\' };
    const text = render([{ role: 'assistant', content: '', tool_calls: [call('id"\\', 'name"\\', args)] }]);
    assert.deepEqual(callsIn(text), [{ id: 'id"\\', name: 'name"\\', arguments: args }]);
  });

  check('无 id / arguments 的调用仍有合法可读 JSON', () => {
    const text = render([{ role: 'assistant', content: '', tool_calls: [{ function: { name: 'no_args' } }] }]);
    assert.deepEqual(callsIn(text), [{ name: 'no_args', arguments: {} }]);
  });

  check('system 和 developer 设定、工具提示词仍保留', () => {
    const text = render([
      { role: 'system', content: 'SYSTEM' }, { role: 'developer', content: 'DEVELOPER' },
      { role: 'user', content: '普通消息' },
    ], 'TOOL_PROMPT');
    for (const value of ['SYSTEM', 'DEVELOPER', 'TOOL_PROMPT', '普通消息']) assert.ok(text.includes(value));
  });
}

const body = splitMessages([
  { role: 'assistant', content: '调用', tool_calls: [call('x', 'run', {})] },
  { role: 'tool', tool_call_id: 'x', content: '结果' },
  { role: 'user', content: '继续' },
]);
assert.deepEqual(body.chat_history.map((m) => m.role), ['assistant', 'user']);
assert.equal(body.user_input, '继续');

const runtimeContext = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "fixture".';
const withRuntimeContext = splitMessages([
  { role: 'system', content: '遵照用户要求' },
  { role: 'user', content: '先前请求' },
  { role: 'assistant', content: '先前答案' },
  { role: 'user', content: '只回复 DSH_TEXT_PROBE_OK' },
  { role: 'user', content: runtimeContext },
]);
assert.deepEqual(withRuntimeContext.chat_history, [
  { role: 'user', content: '先前请求' },
  { role: 'assistant', content: '先前答案' },
]);
assert.equal(withRuntimeContext.user_input, `[系统设定]\n遵照用户要求\n\n[用户]\n只回复 DSH_TEXT_PROBE_OK\n\n${runtimeContext}`);

const parallelResults = splitMessages([
  { role: 'user', content: '读取两项' },
  { role: 'assistant', tool_calls: [call('a', 'first', {}), call('b', 'second', {})] },
  { role: 'tool', tool_call_id: 'a', content: '结果 A' },
  { role: 'function', tool_call_id: 'b', content: '结果 B' },
  { role: 'user', content: runtimeContext },
]);
assert.deepEqual(parallelResults.chat_history.map((m) => m.role), ['user', 'assistant']);
assert.equal(parallelResults.user_input, `[工具结果 name="first" id="a"]\n结果 A\n\n[工具结果 name="second" id="b"]\n结果 B\n\n${runtimeContext}`);
console.log(`\n${passed + 3} tool history checks passed (offline).`);
