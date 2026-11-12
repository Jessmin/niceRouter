/**
 * Qoder 混合闭合（XML 开 + DSML parameter 收）真实样本回归（离线，零执行）
 * ==================================================================
 * 这两条形状来自 2026-11-10 线上真实失败的捕获前缀：
 *   `<tool_call>{完整单 JSON}</｜｜DSML｜｜ parameter>`
 * 旧实现把它当「无法解析的工具调用标记」整轮 502；新引擎把它当正常拼写。
 *
 * 覆盖：全部分割点、各种尾部闭合别名，以及必须被拒绝的残缺形态。
 */
import assert from 'node:assert/strict';
import { ToolMarkupSieve } from '../src/toolcall.js';

const args = '{ "large": 9007199254740993, "escaped": "\\u4e2d", "marker": "fixture-only" }';
const payload = `{"id":"fixture_mixed_id","name":"fixture_probe","arguments":${args}}`;
const closers = [
  '</｜｜DSML｜｜ parameter>',
  '</｜｜DSML｜｜parameter>',
  '</||DSML|| parameter>',
  '</｜｜DSML｜｜ calls>',
  '</｜｜DSML｜｜ invoke>',
  '</tool_call>',
  '</call_call>',
  '',
];
const options = { allowedNames: ['fixture_probe'], strictAfterCalls: true, engine: 'next' };
let count = 0;

function parse(chunks, override = {}) {
  const sieve = new ToolMarkupSieve({ ...options, ...override });
  const parts = chunks.map((chunk) => sieve.push(chunk)).concat(sieve.flush());
  return {
    text: parts.map((part) => part.text || '').join(''),
    calls: parts.flatMap((part) => part.calls),
    stopped: sieve.stopped,
  };
}

function splits(source) {
  const out = [Array.from(source), [source]];
  for (let at = 0; at <= source.length; at += 1) out.push([source.slice(0, at), source.slice(at)]);
  for (const size of [2, 7, 31]) {
    const chunks = [];
    for (let i = 0; i < source.length; i += size) chunks.push(source.slice(i, i + size));
    out.push(chunks);
  }
  return out;
}

const expected = { id: 'fixture_mixed_id', name: 'fixture_probe', arguments: args };

// 1. 真实样本：每种尾部别名 × 全部分割点都必须还原出同一条调用
for (const closer of closers) {
  const source = `<tool_call>${payload}${closer}`;
  for (const chunks of splits(source)) {
    const out = parse(chunks);
    assert.deepEqual(out.calls, [expected], `closer ${JSON.stringify(closer)}`);
    assert.equal(out.text, '');
    count += 1;
  }
}

// 2. 前面的正文原样保留
for (const prefix of ['', ' ', '   ', 'Fixture explanation.\n', 'Fixture explanation.\r\n  ']) {
  for (const chunks of splits(prefix + `<tool_call>${payload}</｜｜DSML｜｜ parameter>`)) {
    const out = parse(chunks);
    assert.equal(out.text, prefix);
    assert.deepEqual(out.calls, [expected]);
    count += 1;
  }
}

// 3. 并列批次：紧邻的两条都算本轮调用
for (const source of [`<tool_call>${payload}</tool_call>\n<tool_call>${payload}</tool_call>`,
  `<tool_calls>[${payload},${payload}]</tool_calls>`]) {
  for (const chunks of splits(source)) {
    assert.deepEqual(parse(chunks).calls, [expected, expected]);
    count += 1;
  }
}

// 4. 调用之后的模型自编结果被丢掉
for (const chunks of splits(`<tool_call>${payload}</tool_call>\nFixture invented result.\n<tool_call>${payload}</tool_call>`)) {
  const out = parse(chunks);
  assert.deepEqual(out.calls, [expected]);
  assert.equal(out.text, '');
  assert.equal(out.stopped, true);
  count += 1;
}

// 5. 未声明的工具既不下发也不失败
for (const chunks of [[`<tool_call>${payload}</tool_call>`], Array.from(`<tool_call>${payload}</tool_call>`)]) {
  const out = parse(chunks, { allowedNames: ['fixture_other'] });
  assert.deepEqual(out.calls, []);
  count += 1;
}

// 6. 参数残缺/非对象/缺工具名：一条都不许变成可执行调用
const rejected = [
  `<tool_call>${payload.slice(0, -1)}</tool_call>`,
  '<tool_call>{"name":"fixture_probe","arguments":{"marker":"unterminated}</tool_call>',
  '<tool_call>{"name":"fixture_probe","arguments":{"bad":}}</tool_call>',
  '<tool_call>{"name":"fixture_probe","arguments":[]}</tool_call>',
  '<tool_call>{"name":"fixture_probe","arguments":"[]"}</tool_call>',
  '<tool_call>{"name":"fixture_probe","arguments":1}</tool_call>',
];
for (const source of rejected) {
  for (const chunks of [[source], Array.from(source)]) {
    const out = parse(chunks);
    assert.deepEqual(out.calls, [], JSON.stringify(source).slice(0, 80));
    count += 1;
  }
}

// 7. 同一个标签里连写两段 payload：模型写了两条完整调用，就还原两条
for (const chunks of splits(`<tool_call>${payload}${payload}</tool_call>`)) {
  assert.deepEqual(parse(chunks).calls, [expected, expected]);
  count += 1;
}

console.log(`PASS ${count} Qoder mixed-close framing checks (synthetic, tools executed: 0)`);
