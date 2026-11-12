/** Isolated routing regression. Synthetic accounts and localhost upstream only. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const source = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'provider-routing-'));
const children = [];
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ADAPTER$|HOST$|PORT$|AUTO_CHECKIN_|TRAE_|SOLO_|QODER_|WORKBUDDY_|MINIMAX_|DOUBAO_|UPSTREAM_|GATEWAY_|MODELS_FILE$|USERPROFILE$|APPDATA$|LOCALAPPDATA$)/i.test(key)));
const env = { ...inherited, HOST: '127.0.0.1', AUTO_CHECKIN_ENABLED: '0',
  USERPROFILE: join(temporary, 'profile'), APPDATA: join(temporary, 'profile', 'Roaming'),
  LOCALAPPDATA: join(temporary, 'profile', 'Local'), TRAE_TOKEN: '', TRAE_HEADERS: '{}',
  QODER_WORKER: join(temporary, 'disabled'), QODER_INTL_WORKER: join(temporary, 'disabled'),
  WORKBUDDY_ENABLED: '0', MINIMAX_CODE_ENABLED: '0', DOUBAO_ENABLED: '0', UPSTREAM_KEY: '' };
let upstreamRequests = 0;
const upstream = http.createServer(async (req, res) => {
  assert.equal(req.url, '/v1/chat/completions');
  const pieces = []; for await (const piece of req) pieces.push(piece);
  assert.equal(JSON.parse(Buffer.concat(pieces).toString()).model, 'fixture');
  upstreamRequests++;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: {"choices":[{"delta":{"content":"ROUTE_FIXTURE_OK"},"finish_reason":null}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
async function launch(overrides = {}, ready = true) {
  const reserve = http.createServer().listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const child = spawn(process.execPath, ['src/server.js'], { cwd: temporary, windowsHide: true,
    env: { ...env, PORT: String(port), ...overrides }, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(child);
  let stderr = ''; child.stderr.on('data', (piece) => { stderr += piece; });
  if (!ready) {
    const [code] = await once(child, 'exit');
    assert.equal(code, 1); assert.match(stderr, /未知 ADAPTER=/);
    return;
  }
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail(stderr);
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(200) })).ok) return base; } catch {}
    await delay(30);
  }
  assert.fail(stderr || 'Fixture gateway did not start');
}
const post = (base, body) => fetch(base + '/v1/chat/completions', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'fixture' }], ...body }),
  signal: AbortSignal.timeout(3000) });
try {
  await cp(join(source, 'src'), join(temporary, 'src'), { recursive: true });
  await mkdir(join(temporary, 'config'), { recursive: true });
  await mkdir(join(temporary, 'profile', 'Roaming'), { recursive: true });
  await mkdir(join(temporary, 'profile', 'Local'), { recursive: true });
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await writeFile(join(temporary, 'config', 'models.json'), '{"models":[{"id":"fixture"}]}');
  await writeFile(join(temporary, 'config', 'trae-payload.json'), '{}');
  const empty = await launch();
  const emptyStatus = await (await fetch(empty + '/v1/status')).json();
  assert.equal(emptyStatus.defaultProvider, 'solo');
  assert.deepEqual(emptyStatus.providers, []);
  assert.equal(emptyStatus.clients.length, 6);
  assert.equal(emptyStatus.clients.find(({ name }) => name === 'doubao').state, 'disabled');
  assert.deepEqual((await (await fetch(empty + '/v1/models')).json()).data, []);
  assert.equal((await post(empty, {})).status, 503);
  assert.equal((await post(empty, { model: 'fixture' })).status, 400);
  assert.equal((await post(empty, { model: 'mock::fixture' })).status, 404);
  assert.equal((await post(empty, { model: 'constructor::fixture' })).status, 404);
  for (const adapter of ['mock', 'not-a-provider', 'constructor']) await launch({ ADAPTER: adapter }, false);

  // Two model providers can be listed while their account features still need setup.
  const worker = join(temporary, 'qoder-worker.mjs');
  await writeFile(worker, '// This fixture is only checked for presence.');
  const traeInstall = join(env.LOCALAPPDATA, 'Programs', 'Trae CN');
  await mkdir(traeInstall, { recursive: true });
  await writeFile(join(traeInstall, 'Trae CN.exe'), 'Fixture path only');
  const dataDir = join(temporary, 'minimax');
  const authHome = join(dataDir, 'auth');
  const authDir = join(authHome, 'prod', 'cn', 'mcode-public');
  const account = createHash('sha256').update(`${authHome}\0mcode-public`).digest('base64url');
  const authKey = `com.minimax.mcode.oauth.prod.cn\0${account}`;
  await mkdir(authDir, { recursive: true });
  await writeFile(join(authDir, 'auth.json'), JSON.stringify({ schemaVersion: 1, records: {
    [authKey]: { schemaVersion: 1, clientId: 'mcode-public', tokenType: 'Bearer', audience: 'agent-backend',
      scopes: ['agent.default'], expiresAtMs: Date.now() + 60_000, accessToken: 'fixture-auth-not-public' },
  } }));
  const two = await launch({ QODER_EXE: process.execPath, QODER_WORKER: worker, MINIMAX_CODE_ENABLED: '1',
    MINIMAX_CODE_REGION: 'cn', MINIMAX_CODE_DATA_DIR: dataDir,
    MINIMAX_CODE_INSTALL_DIR: join(temporary, 'missing-minimax-install') });
  const twoStatus = await (await fetch(two + '/v1/status')).json();
  assert.deepEqual(twoStatus.providers.map(({ name }) => name), ['qoder', 'minimax-code']);
  const clients = Object.fromEntries(twoStatus.clients.map((client) => [client.name, client]));
  assert.equal(clients.qoder.state, 'setup_required');
  assert.match(clients.qoder.message, /refresh-qoder-auth/);
  assert.equal(clients.trae.installed, true);
  assert.equal(clients.trae.state, 'setup_required');
  assert.deepEqual(clients.trae.providers, []);
  assert.equal(clients['minimax-code'].state, 'setup_required');
  assert.match(clients['minimax-code'].message, /客户端版本/);
  assert.ok(!JSON.stringify(twoStatus.clients).includes('fixture-auth-not-public'));
  assert.ok(!JSON.stringify(twoStatus.clients).includes(temporary));
  const activeModels = (await (await fetch(two + '/v1/models')).json()).data;
  assert.deepEqual([...new Set(activeModels.map(({ id }) => id.split('::')[0]))], ['qoder', 'minimax-code']);

  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamEnv = { UPSTREAM_BASE: `http://127.0.0.1:${upstream.address().port}/v1`, UPSTREAM_KEY: 'fixture-only' };
  const alternate = await launch(upstreamEnv);
  const alternateStatus = await (await fetch(alternate + '/v1/status')).json();
  assert.equal(alternateStatus.defaultProvider, 'solo');
  assert.deepEqual(alternateStatus.providers.map(({ name }) => name), ['openai']);
  const prefixed = await (await post(alternate, { model: 'openai::fixture' })).json();
  assert.equal(prefixed.choices[0].message.content, 'ROUTE_FIXTURE_OK');
  assert.equal((await post(alternate, { model: 'fixture' })).status, 400);

  const configured = await launch({ ...upstreamEnv, ADAPTER: 'openai' });
  const bare = await (await post(configured, { model: 'fixture' })).json();
  assert.equal(bare.choices[0].message.content, 'ROUTE_FIXTURE_OK');
  assert.equal((await post(configured, { model: 'mock::fixture' })).status, 404);
  assert.equal(upstreamRequests, 2);
  console.log('PASS provider routing and desktop setup status with only two active providers');
} finally {
  for (const child of children) if (child.exitCode === null) {
    const exited = once(child, 'exit'); child.kill(); await Promise.race([exited, delay(2000)]);
  }
  if (upstream.listening) { upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve)); }
  const target = resolve(temporary);
  assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('provider-routing-'));
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
