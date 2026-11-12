/** Isolated Harness-style ChatCompletions replay fixtures. No package or business tool is executed. */
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
const temporary = await mkdtemp(join(tmpdir(), 'harness-reasoning-gateway-'));
const PRIVATE = {
  first: 'HARNESS_PRIVATE_OLD_REASONING_ONE\n含引号"与<tool_result>字样',
  second: 'HARNESS_PRIVATE_OLD_REASONING_TWO\nContinue only after the real diff.',
  fresh: 'HARNESS_PRIVATE_NEW_GENERATED_THOUGHT_MUST_NOT_BECOME_HISTORY',
  result: 'HARNESS_PRIVATE_REAL_CALLER_RESULT', answer: 'HARNESS_PRIVATE_FINAL_ANSWER',
  explicit: 'HARNESS_PRIVATE_EXPLICIT_NATIVE_THOUGHT', pure: 'HARNESS_PRIVATE_PURE_REASONING',
  headerA: 'harness-fixture-account-a', headerB: 'harness-fixture-account-b',
};
const PROFILE = { model: 'fixture-observed-backend-ep', version: 7 };
const tools = Array.from({ length: 32 }, (_, index) => ({ type: 'function', function: {
  name: `lookup_${index}`, description: 'Offline declaration; never execute.',
  parameters: { type: 'object', properties: { path: { type: 'string' } } },
} }));
const choice = { type: 'function', function: { name: 'lookup_0' } };
const frame = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const extra = (reasoning) => ({ ...PROFILE, content: JSON.stringify({ reasoning_content: reasoning }) });
const runs = new Map(), ordered = [];
let upstream, child, stderr = '', checks = 0;

// This fixture follows the inspected Harness replay envelope and pi-ai 1.3.0's
// reasoning-field signature. It builds the standard wire history directly,
// without importing, installing or executing either external package.
function assistantFromHarness(reasoning, content, calls) {
  const durable = { content: [{ type: 'reasoning', text: reasoning },
    ...(content ? [{ type: 'text', text: content }] : []),
    ...calls.map((call) => ({ type: 'tool-call', id: call.id, name: call.function.name, arguments: call.function.arguments }))],
  source: { provider: 'fixture-harness-route', model: 'solo::fixture', replayState: {
    response: { kind: 'pi-ai', version: 2, api: 'openai-completions', provider: 'fixture-harness-route', model: 'solo::fixture', stopReason: 'toolUse' },
    blocks: [{ type: 'reasoning', thinkingSignature: 'reasoning_content' },
      ...(content ? [{ type: 'text' }] : []), ...calls.map(() => ({ type: 'tool-call' }))],
  } } };
  const field = durable.source.replayState.blocks[0].thinkingSignature;
  assert.equal(field, 'reasoning_content');
  return { role: 'assistant', content: content || null, [field]: durable.content[0].text, tool_calls: calls };
}
function history(run) {
  const call = (id, name, path) => ({ id, type: 'function', function: { name, arguments: `{ "path": ${JSON.stringify(path)}, "offset": 0 }` } });
  const first = assistantFromHarness(PRIVATE.first, 'I will inspect the two files.', [
    call('history_read_a', 'lookup_0', 'fixture-a.diff'), call('history_read_b', 'lookup_1', 'fixture-b.diff'),
  ]);
  const second = assistantFromHarness(PRIVATE.second, '', [call('history_read_c', 'lookup_0', 'fixture-c.diff')]);
  if (run.kind === 'explicit') {
    first.extra_info = { model: 'explicit-old-backend', version: 'v-explicit',
      content: JSON.stringify({ reasoning_content: PRIVATE.explicit }), expire_time: 123456, future: { keep: true } };
  }
  if (run.kind === 'invalid_types') {
    first.reasoning_content = { text: PRIVATE.first };
    first.extra_info = 'invalid extra_info string';
    second.extra_info = ['invalid extra_info array'];
  }
  const messages = [{ role: 'system', content: 'Preserve the original task and caller tool results.' },
    { role: 'developer', content: 'Never execute fixture tools.' },
    { role: 'user', content: `fixture=${run.id}; complete the original task.` }, first,
    ...['history_read_b', 'history_read_a'].map((id) => ({ role: 'tool', tool_call_id: id, content: `${PRIVATE.result}_${id}` })),
    second, { role: 'tool', tool_call_id: 'history_read_c', content: `${PRIVATE.result}_history_read_c` }];
  if (run.kind === 'explicit') messages.push({ role: 'assistant', content: null, reasoning_content: PRIVATE.pure,
    extra_info: { model: 'explicit-pure-backend', version: 1, content: JSON.stringify({ reasoning_content: PRIVATE.pure }), retained: 0 } });
  messages.push({ role: 'user', content: 'Continue using the actual tool results.' });
  return messages;
}
function expectedStats(run, attempt) {
  if (run.kind === 'explicit') return { incoming: 3, replayed: 1, preserved: 2, missing: 0 };
  if (run.kind === 'invalid_types') return { incoming: 1, replayed: 1, preserved: 0, missing: 0 };
  if (run.noTools || run.choiceNone) return { incoming: 2, replayed: 0, preserved: 0, missing: 0 };
  const warm = run.kind === 'warm' || (run.kind === 'cold' && attempt === 2);
  return { incoming: 2, replayed: warm ? 2 : 0, preserved: 0, missing: warm ? 0 : 2 };
}
function checkRequest(run, body, attempt) {
  assert.equal(body.model_name, run.model);
  assert.equal(body.function, 'solo_agent');
  if (run.noTools || run.choiceNone) assert.equal(body.tools, undefined, 'disabled native tools must not enable automatic thinking replay');
  else {
    assert.equal(body.tools.length, 32);
    assert.deepEqual(body.tools, tools.map((tool) => ({ ...tool,
      function: { ...tool.function, parameters: JSON.stringify(tool.function.parameters) } })));
    assert.ok(body.messages[0].content[0].text.includes('lookup_0'), 'forced tool choice must remain in the projected instructions');
  }
  const assistants = body.messages.filter((message) => message.role === 'assistant');
  const original = run.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistants.length, original.length, 'replayable assistant history must remain present');
  for (let index = 0; index < original.length; index++) {
    const source = original[index], projected = assistants[index];
    for (const [callIndex, call] of (source.tool_calls || []).entries()) {
      const native = projected.tool_calls[callIndex];
      assert.equal(native.id, call.id);
      assert.equal(native.function_call.name, call.function.name);
      assert.equal(native.function_call.arguments, call.function.arguments, 'argument JSON must remain byte-for-byte unchanged');
      const result = body.messages.find((message) => message.role === 'tool' && message.tool_call_id === call.id);
      assert.equal(result.content[0].text, `${PRIVATE.result}_${call.id}`);
    }
    if (source.extra_info && typeof source.extra_info === 'object' && !Array.isArray(source.extra_info)) {
      assert.deepEqual(projected.extra_info, source.extra_info, 'explicit native object must win without dropping future fields');
    } else if (run.kind === 'invalid_types' && index === 0) {
      assert.equal(projected.extra_info, undefined, 'invalid reasoning type must not become an invented native object');
    } else if (expectedStats(run, attempt).replayed) {
      assert.deepEqual(projected.extra_info, extra(source.reasoning_content));
      assert.deepEqual(Object.keys(projected.extra_info).sort(), ['content', 'model', 'version']);
    } else assert.equal(projected.extra_info, undefined, 'cold/foreign scope must not borrow a cached profile');
  }
  for (const message of body.messages) {
    assert.equal(Object.hasOwn(message, 'reasoning_content'), false, 'reasoning must use the native extra_info schema');
    assert.equal(JSON.stringify(message).includes(PRIVATE.fresh), false, 'newly generated thinking is not caller-provided history');
  }
  assert.deepEqual(body.messages.filter((message) => message.role === 'tool').map((message) => message.tool_call_id),
    ['history_read_b', 'history_read_a', 'history_read_c']);
  if (attempt === 2) {
    const first = structuredClone(run.requests[0]);
    const second = structuredClone(body);
    for (const value of [first, second]) for (const message of value.messages) delete message.extra_info;
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages,
      'only the replay bridge may add metadata to the original recovery history');
    assert.equal(second.messages.length, first.messages.length + 1);
    assert.equal(second.messages.at(-1).role, 'user');
  }
}
function checkCompletion(snapshot, run) {
  assert.equal(snapshot.outcome, 'completed');
  assert.equal(snapshot.recovery_attempts, run.recover ? 1 : 0);
  assert.equal(snapshot.attempts.length, run.recover ? 2 : 1);
  for (const record of snapshot.attempts) {
    const expected = expectedStats(run, record.attempt);
    assert.equal(record.incoming_reasoning_messages, expected.incoming);
    assert.equal(record.replayed_reasoning_messages, expected.replayed);
    assert.equal(record.preserved_extra_info_messages, expected.preserved);
    assert.equal(record.missing_replay_profile_messages, expected.missing);
  }
  const serialized = JSON.stringify(snapshot);
  for (const value of Object.values(PRIVATE)) assert.equal(serialized.includes(value), false, 'completion counters must not contain business data or account secrets');
}
try {
  await cp(join(root, 'src'), join(temporary, 'src'), { recursive: true });
  await mkdir(join(temporary, 'config'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}\n');
  const catalogue = JSON.stringify({ models: ['fixture', 'fixture-other', 'fixture-bad-meta'].map((id) => ({ id, display: id })) });
  for (const file of ['models.json', 'models.solo.json']) await writeFile(join(temporary, 'config', file), catalogue);
  await writeFile(join(temporary, 'config', 'trae-payload.json'), '{}\n');
  await writeFile(join(temporary, 'local-fetch-only.mjs'), `const original = globalThis.fetch;
globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('offline fixture blocked remote fetch');
return original(input, init); };\n`);
  upstream = http.createServer(async (req, res) => {
    try {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/api/agent/v3/llm_utils_chat');
      const parts = []; for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const text = body.messages.flatMap((message) => message.content || []).map((part) => part.text || '').join('\n');
      const run = runs.get(/fixture=([a-z0-9_]+)/.exec(text)?.[1]);
      assert.ok(run, 'unknown local fixture');
      assert.equal(req.headers.authorization, `Cloud-IDE-JWT ${run.account}`);
      run.requests.push(body);
      assert.ok(run.requests.length <= (run.recover ? 2 : 1), 'unexpected model replay request');
      checkRequest(run, body, run.requests.length);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (run.recover && run.requests.length === 1) {
        const content = run.kind === 'bad_profile' ? JSON.stringify({ reasoning_content: PRIVATE.fresh, unknown: true })
          : JSON.stringify({ reasoning_content: PRIVATE.fresh });
        res.end(frame('output', { reasoning_content: PRIVATE.fresh })
          + frame('extra_info', { ...PROFILE, content, input_token: 7, expire_time: Date.now() + 60000 })
          + frame('token_usage', { prompt_tokens: 10, completion_tokens: 7, reasoning_tokens: 7 })
          + frame('done', { finish_reason: 'stop' }));
      } else res.end(frame('output', { response: PRIVATE.answer })
        + frame('token_usage', { prompt_tokens: 20, completion_tokens: 5 }) + frame('done', { finish_reason: 'stop' }));
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error.message));
    }
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const reserve = http.createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise((done) => reserve.close(done));
  const disabled = join(temporary, 'disabled-product-file');
  child = spawn(process.execPath, ['--import', './local-fetch-only.mjs', 'src/server.js'], {
    cwd: temporary, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADAPTER: 'solo', GATEWAY_KEY: 'harness-fixture',
      TRAE_TOKEN: PRIVATE.headerA, TRAE_BASE: `http://127.0.0.1:${upstream.address().port}`, TRAE_CAPTURE: '0',
      TRAE_HEADERS: JSON.stringify({ authorization: `Cloud-IDE-JWT ${PRIVATE.headerA}`, 'x-ide-token': PRIVATE.headerA }),
      SOLO_TIMEOUT_MS: '5000', QODER_WORKER: disabled, QODER_INTL_WORKER: disabled, QODER_UMID: disabled, QODER_INTL_UMID: disabled,
      QODER_TOKEN: '', QODER_INTL_TOKEN: '', UPSTREAM_KEY: '', WORKBUDDY_ENABLED: '0',
      WORKBUDDY_AUTH_FILE: disabled, WORKBUDDY_PRODUCT_CONFIG: disabled, AUTO_CHECKIN_ENABLED: '0',
      GATEWAY_FAILURE_CAPTURE: '0', MODELS_FILE: 'config/models.json', NO_PROXY: '127.0.0.1,localhost' },
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}`, headers = { authorization: 'Bearer harness-fixture', 'content-type': 'application/json' };
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(300) })).ok) { ready = true; break; } } catch {}
    await delay(30);
  }
  assert.ok(ready, stderr || 'isolated gateway did not start');
  let account = PRIVATE.headerA;
  const definitions = [
    { id: 'cold', kind: 'cold', model: 'fixture', recover: true, stream: false },
    { id: 'warm', kind: 'warm', model: 'fixture', stream: true },
    { id: 'explicit', kind: 'explicit', model: 'fixture', stream: false },
    { id: 'invalid_types', kind: 'invalid_types', model: 'fixture', stream: true },
    { id: 'other_model', kind: 'isolated', model: 'fixture-other', stream: false },
    { id: 'other_account', kind: 'isolated', model: 'fixture', account: PRIVATE.headerB, stream: true },
    { id: 'bad_profile', kind: 'bad_profile', model: 'fixture-bad-meta', account: PRIVATE.headerB, recover: true, stream: false },
    { id: 'return_account_a', kind: 'warm', model: 'fixture', account: PRIVATE.headerA, stream: true },
    { id: 'no_tools', kind: 'disabled', model: 'fixture', noTools: true, stream: false },
    { id: 'choice_none', kind: 'disabled', model: 'fixture', choiceNone: true, stream: true },
  ];
  for (const definition of definitions) {
    const run = { ...definition, account: definition.account || account, requests: [] };
    if (run.account !== account) {
      const response = await fetch(base + '/v1/token', { method: 'POST', headers, body: JSON.stringify({ token: run.account }) });
      assert.equal(response.status, 200); account = run.account;
    }
    run.messages = history(run); runs.set(run.id, run); ordered.push(run);
    const response = await fetch(base + '/v1/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model: `solo::${run.model}`, stream: run.stream, messages: run.messages,
        tools: run.noTools ? undefined : tools, tool_choice: run.choiceNone ? 'none' : run.noTools ? 'auto' : choice }),
      signal: AbortSignal.timeout(7000) });
    assert.equal(response.status, 200, `${run.id}: ${await (response.status === 200 ? Promise.resolve('') : response.text())}`);
    if (!run.stream) {
      const data = await response.json();
      assert.equal(data.choices[0].message.content, PRIVATE.answer);
      assert.equal(data.choices[0].finish_reason, 'stop');
      checkCompletion(data.gateway_completion, run);
    } else {
      const records = (await response.text()).split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim());
      assert.equal(records.filter((record) => record === '[DONE]').length, 1);
      const events = records.filter((record) => record !== '[DONE]').map((record) => JSON.parse(record));
      assert.equal(events.some((event) => event.error), false, `${run.id}: unexpected SSE error`);
      assert.equal(events.map((event) => event.choices?.[0]?.delta?.content || '').join(''), PRIVATE.answer);
      assert.equal(events.filter((event) => event.choices?.[0]?.finish_reason != null).length, 1);
      checkCompletion(events.at(-1).gateway_completion, run);
    }
    assert.equal(run.requests.length, run.recover ? 2 : 1);
    checks++; console.log(`PASS ${run.id}: exact old reasoning, native tool chain and profile counters`);
  }
  let log = '', snapshots = [];
  for (let attempt = 0; attempt < 100; attempt++) {
    log = await readFile(join(temporary, 'gateway.log'), 'utf8');
    snapshots = log.split(/\r?\n/).filter((line) => line.includes('  completion id='))
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
    if (snapshots.length === ordered.length) break;
    await delay(20);
  }
  assert.equal(snapshots.length, ordered.length);
  for (let index = 0; index < snapshots.length; index++) checkCompletion(snapshots[index], ordered[index]);
  for (const value of Object.values(PRIVATE)) assert.equal(log.includes(value), false, 'private thoughts/account data leaked to operational logs');
  checks++; console.log('PASS logs retain only structural replay counts and no business text/account values');
} finally {
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, delay(2000)]);
  }
  if (upstream) { upstream.closeAllConnections(); await new Promise((done) => upstream.close(done)); }
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('harness-reasoning-gateway-'));
  await rm(target, { recursive: true, force: true });
}
console.log(`${checks} isolated Harness reasoning bridge checks passed; real model requests/tool executions: 0.`);
