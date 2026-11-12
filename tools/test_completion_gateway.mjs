/** Isolated HTTP completion regression. Synthetic config and localhost SSE only. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'completion-gateway-'));
const PROMPT = 'COMPLETION_PRIVATE_PROMPT_SENTINEL';
const TEXT = 'COMPLETION_PRIVATE_ANSWER_SENTINEL';
const REASONING = 'COMPLETION_PRIVATE_REASONING_SENTINEL';
const ARGUMENT = 'COMPLETION_PRIVATE_ARGUMENT_SENTINEL';
const usage = ['token_usage', { prompt_tokens: 11, completion_tokens: 7, reasoning_tokens: 3 }];
const end = (reason) => ['done', reason == null ? {} : { finish_reason: reason }];
const native = (args, first = false) => ['output', { tool_calls: [{ index: 0,
  ...(first ? { id: 'call_completion_fixture', type: 'function' } : {}),
  function_call: { ...(first ? { name: 'lookup' } : {}), arguments: args } }] }];
const scenarios = [
  ...['stop', 'length', undefined].map((reason, index) => ({ name: `reasoning_${index}`, reason,
    events: [['output', { reasoning_content: REASONING }], usage, end(reason)], error: 'upstream_reasoning_only', reasoning: true })),
  { name: 'empty', reason: 'stop', events: [end('stop')], error: 'upstream_empty_response' },
  { name: 'partial_text', reason: 'length', events: [['output', { response: TEXT }], usage, end('length')], text: TEXT, finish: 'length', outcome: 'incomplete' },
  { name: 'normal_text', reason: 'stop', events: [['output', { response: TEXT }], usage, end('stop')], text: TEXT, finish: 'stop', outcome: 'completed' },
  { name: 'tool_only', reason: 'tool_calls', events: [native('{}', true), usage, end('tool_calls')], tools: true, expectedArguments: {}, finish: 'tool_calls', outcome: 'completed' },
  { name: 'incomplete_tool', reason: 'length', events: [native('{', true), usage, end('length')], error: 'upstream_incomplete_tool_call' },
  { name: 'incremental_tool', reason: 'tool_calls', events: [native('{"file_path":', true), native(JSON.stringify(ARGUMENT) + '}'), usage, end('tool_calls')],
    tools: true, expectedArguments: { file_path: ARGUMENT }, finish: 'tool_calls', outcome: 'completed' },
  { name: 'guard_incomplete_tool', reason: null, termination: 'tool_turn_boundary', events: [native('{"file_path":"', true),
    ['output', { response: `<tool_call>{"name":"lookup","arguments":{"file_path":"${ARGUMENT}"}}</tool_call>\nUser: invented continuation` }],
    native(ARGUMENT + '"}'), end('stop')], error: 'upstream_incomplete_tool_call' },
];
const byName = new Map(scenarios.map((scenario) => [scenario.name, scenario]));
const requests = [];
const completedScenarios = [];
let upstream, child, stderr = '', checks = 0;
const frame = ([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function parseStream(source) {
  const data = source.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
  assert.equal(data.filter((item) => item === '[DONE]').length, 1);
  const events = data.filter((item) => item !== '[DONE]').map((item) => JSON.parse(item));
  const calls = new Map();
  let text = '', reasoning = '';
  for (const event of events) {
    const delta = event.choices?.[0]?.delta || {};
    text += delta.content || ''; reasoning += delta.reasoning_content || '';
    for (const part of delta.tool_calls || []) {
      const call = calls.get(part.index) || { id: '', function: { name: '', arguments: '' } };
      if (part.id) call.id = part.id;
      if (part.function?.name) call.function.name = part.function.name;
      call.function.arguments += part.function?.arguments || '';
      calls.set(part.index, call);
    }
  }
  return { events, text, reasoning, calls: [...calls.values()] };
}

function checkSnapshot(snapshot, scenario) {
  assert.ok(snapshot && typeof snapshot === 'object', 'completion evidence missing');
  for (const key of ['text_chars', 'reasoning_chars', 'tool_calls']) assert.equal(typeof snapshot[key], 'number', key);
  assert.equal(snapshot.termination_reason, scenario.termination || 'upstream_done');
  assert.equal(snapshot.upstream_finish_reason, scenario.reason || null);
  assert.equal(snapshot.outcome, scenario.error ? 'error' : scenario.outcome);
  assert.equal(snapshot.finish_reason, scenario.error ? null : scenario.finish);
  if (scenario.error) assert.equal(snapshot.error_code, scenario.error);
  if (scenario.reasoning) assert.equal(snapshot.reasoning_chars, REASONING.length);
  if (scenario.text) assert.equal(snapshot.text_chars, scenario.text.length);
  if (scenario.tools) assert.equal(snapshot.tool_calls, 1);
  if (Object.hasOwn(snapshot, 'adapter_done')) assert.equal(snapshot.adapter_done, true);
  if (Object.hasOwn(snapshot, 'upstream_done')) assert.equal(snapshot.upstream_done, scenario.termination !== 'tool_turn_boundary');
  if (snapshot.token_counts) {
    const attempts = scenario.name === 'reasoning_0' ? 2 : 1;
    assert.equal(snapshot.token_counts.prompt_tokens, 11 * attempts);
    assert.equal(snapshot.token_counts.completion_tokens, 7 * attempts);
    if (Object.hasOwn(snapshot.token_counts, 'reasoning_tokens')) assert.equal(snapshot.token_counts.reasoning_tokens, 3 * attempts);
  }
  const forbidden = new Set(['prompt', 'messages', 'text', 'reasoning', 'arguments', 'content']);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, childValue] of Object.entries(value)) { assert.equal(forbidden.has(key), false, `content field ${key} must not be logged`); visit(childValue); }
  };
  visit(snapshot);
  for (const secret of [PROMPT, TEXT, REASONING, ARGUMENT]) assert.equal(JSON.stringify(snapshot).includes(secret), false);
}

try {
  // No real config/session/credentials are copied into the child gateway.
  await cp(join(root, 'src'), join(temporary, 'src'), { recursive: true });
  await mkdir(join(temporary, 'config'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n');
  const catalogue = '{"models":[{"id":"fixture","display":"Offline fixture"}]}\n';
  await writeFile(join(temporary, 'config', 'models.json'), catalogue);
  await writeFile(join(temporary, 'config', 'models.solo.json'), catalogue);
  await writeFile(join(temporary, 'config', 'trae-payload.json'), '{}\n');

  upstream = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, '/api/agent/v3/llm_utils_chat');
      const parts = []; for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const text = (body.messages || []).flatMap((message) => message.content || [])
        .find((part) => typeof part.text === 'string' && part.text.includes(PROMPT))?.text || '';
      const scenario = byName.get(/case=([a-z0-9_]+)/.exec(text)?.[1]);
      assert.ok(scenario, 'unknown local scenario');
      requests.push(scenario);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(scenario.events.map(frame).join(''));
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error.message));
    }
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reserve = http.createServer().listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  const disabled = join(temporary, 'disabled-product-file');
  child = spawn(process.execPath, ['src/server.js'], {
    cwd: temporary, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADAPTER: 'solo', GATEWAY_KEY: 'completion-fixture',
      TRAE_TOKEN: 'fixture-only', TRAE_BASE: `http://127.0.0.1:${upstream.address().port}`, TRAE_CAPTURE: '0',
      TRAE_HEADERS: '{"authorization":"Cloud-IDE-JWT fixture-only","x-ide-token":"fixture-only"}',
      SOLO_TIMEOUT_MS: '4000', QODER_WORKER: disabled, QODER_INTL_WORKER: disabled,
      QODER_UMID: disabled, QODER_INTL_UMID: disabled, QODER_INTL_TOKEN: '', UPSTREAM_KEY: '',
      WORKBUDDY_ENABLED: '0', WORKBUDDY_AUTH_FILE: disabled, WORKBUDDY_PRODUCT_CONFIG: disabled,
      AUTO_CHECKIN_ENABLED: '0', MODELS_FILE: 'config/models.json', NO_PROXY: '127.0.0.1,localhost' },
  });
  child.stderr.on('data', (data) => { stderr += data; });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(300) })).ok) { ready = true; break; } } catch {}
    await delay(30);
  }
  assert.ok(ready, stderr || 'isolated gateway failed to start');

  for (const streaming of [false, true]) for (const scenario of scenarios) {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer completion-fixture', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'solo::fixture', stream: streaming,
        messages: [{ role: 'user', content: `${PROMPT}; case=${scenario.name}` }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }] }),
      signal: AbortSignal.timeout(5000),
    });
    if (!streaming) {
      assert.equal(response.status, scenario.error ? 502 : 200, scenario.name);
      const data = await response.json();
      if (scenario.error) {
        assert.equal(data.error?.code, scenario.error);
        assert.equal(data.choices, undefined);
      } else {
        assert.equal(data.choices[0].finish_reason, scenario.finish);
        assert.equal(data.choices[0].message.content, scenario.text || '');
        if (scenario.tools) {
          const calls = data.choices[0].message.tool_calls;
          assert.equal(calls.length, 1); assert.equal(calls[0].id, 'call_completion_fixture');
          assert.deepEqual(JSON.parse(calls[0].function.arguments), scenario.expectedArguments);
        }
        checkSnapshot(data.gateway_completion, scenario);
      }
    } else {
      assert.equal(response.status, 200);
      const result = parseStream(await response.text());
      const errors = result.events.filter((event) => event.error);
      if (scenario.error) {
        assert.equal(errors.length, 1); assert.equal(errors[0].error.code, scenario.error);
        assert.equal(result.events.some((event) => event.choices?.[0]?.finish_reason != null), false, 'error stream must not announce a successful finish');
        if (scenario.reasoning) assert.equal(result.reasoning, REASONING);
      } else {
        assert.equal(errors.length, 0);
        assert.equal(result.text, scenario.text || '');
        assert.equal(result.events.at(-1).choices[0].finish_reason, scenario.finish);
        if (scenario.tools) {
          assert.equal(result.calls.length, 1); assert.equal(result.calls[0].id, 'call_completion_fixture');
          assert.deepEqual(JSON.parse(result.calls[0].function.arguments), scenario.expectedArguments);
        }
      }
      checkSnapshot(result.events.at(-1).gateway_completion, scenario);
    }
    checks++;
    completedScenarios.push(scenario);
    console.log(`PASS ${streaming ? 'stream' : 'nonstream'} ${scenario.name}`);
  }

  let log = '', completions = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    log = await readFile(join(temporary, 'gateway.log'), 'utf8');
    completions = log.split(/\r?\n/).filter((line) => line.includes('  completion id='))
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
    if (completions.length === completedScenarios.length) break;
    await delay(20);
  }
  assert.equal(requests.length, scenarios.length * 2 + 2);
  for (const scenario of scenarios) assert.equal(requests.filter((request) => request === scenario).length,
    scenario.name === 'reasoning_0' ? 4 : 2, `unexpected upstream attempt count for ${scenario.name}`);
  assert.equal(completions.length, completedScenarios.length);
  for (let index = 0; index < completions.length; index++) checkSnapshot(completions[index], completedScenarios[index]);
  for (const secret of [PROMPT, TEXT, REASONING, ARGUMENT]) assert.equal(log.includes(secret), false, 'private fixture content leaked into logs');
  console.log(`PASS ${completions.length} completion logs retain counts/causes without prompt, text or arguments`);
  checks++;
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill();
    await Promise.race([exited, delay(2000)]);
  }
  if (upstream) { upstream.closeAllConnections(); await new Promise((done) => upstream.close(done)); }
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir()));
  assert.ok(basename(target).startsWith('completion-gateway-'));
  await rm(target, { recursive: true, force: true });
}
console.log(`${checks} isolated completion gateway checks passed; product/model requests: 0.`);
