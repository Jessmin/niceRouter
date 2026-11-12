import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('start and stop manage a watched gateway without taking over other listeners', async () => {
  const source = fileURLToPath(new URL('..', import.meta.url));
  const tempRoot = resolve(tmpdir());
  const root = await mkdtemp(join(tempRoot, 'nicerouter watch-'));
  const reserve = http.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((done) => reserve.close(done));
  const base = `http://127.0.0.1:${port}`;
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(HOST$|PORT$|ADAPTER$|AUTO_CHECKIN_|AUTO_DISCOVER_DESKTOP_AUTH$|TRAE_|QODER_|WORKBUDDY_|MINIMAX_|DOUBAO_|UPSTREAM_|GATEWAY_|MODELS_FILE$)/i.test(key)));
  const env = { ...inherited, NODE_EXE: process.execPath };
  const logs = [];
  let supervisor, foreign;
  function command(stop = false) {
    const args = ['--env-file-if-exists=.env', 'tools/start-gateway.mjs', ...(stop ? ['--stop'] : [])];
    const options = { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', stop ? 'stop.bat' : 'start.bat'], options)
      : spawn(process.execPath, args, options);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => logs.push(chunk.toString()));
    return { child, exit: once(child, 'exit') };
  }
  const request = (path) => fetch(base + path, { signal: AbortSignal.timeout(400) });
  async function healthWhere(match) {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const res = await request('/health');
        const state = res.ok && await res.json();
        if (state && match(state)) return state;
      } catch { /* Listener is starting or restarting. */ }
      await delay(60);
    }
    assert.fail(logs.join(''));
  }

  try {
    await Promise.all([
      cp(join(source, 'src'), join(root, 'src'), { recursive: true }),
      ...['package.json', 'start.bat', 'stop.bat'].map((file) => cp(join(source, file), join(root, file))),
      mkdir(join(root, 'config')),
      mkdir(join(root, 'tools')),
    ]);
    await Promise.all([
      cp(join(source, 'tools', 'start-gateway.mjs'), join(root, 'tools', 'start-gateway.mjs')),
      cp(join(source, 'config', 'trae-payload.json'), join(root, 'config', 'trae-payload.json')),
      writeFile(join(root, 'tools', 'workbuddy-cli.cjs'), '// WorkBuddy fixture\n'),
      writeFile(join(root, 'config', 'models.json'), '{"models":[]}'),
      writeFile(join(root, '.env'), [
        'HOST=127.0.0.1', `PORT=${port}`, 'GATEWAY_OPEN_BROWSER=0', 'AUTO_CHECKIN_ENABLED=0',
        'AUTO_DISCOVER_DESKTOP_AUTH=0', 'WORKBUDDY_ENABLED=0', 'MINIMAX_CODE_ENABLED=0', 'DOUBAO_ENABLED=0',
      ].join('\n')),
    ]);

    supervisor = command();
    const first = await healthWhere((state) => state.service === 'nicerouter');
    assert.equal((await request('/v1/models')).status, 401);
    const marker = join(root, '.workbuddy', `gateway-dev-${port}.json`);
    const record = JSON.parse(await readFile(marker, 'utf8'));
    const unauthenticated = await fetch(`http://127.0.0.1:${record.controlPort}/stop`, { method: 'POST' });
    assert.equal(unauthenticated.status, 403);

    assert.equal((await command().exit)[0], 0, logs.join(''));
    assert.equal((await healthWhere(() => true)).pid, first.pid);
    await appendFile(join(root, 'src', 'config.js'), '\n// development watch regression\n');
    const reloaded = await healthWhere((state) => state.pid !== first.pid);
    assert.notEqual(reloaded.build, first.build);
    assert.equal((await request('/v1/models')).status, 401);

    await appendFile(join(root, 'tools', 'workbuddy-cli.cjs'), '// provider wrapper changed\n');
    const wrapperReloaded = await healthWhere((state) => state.pid !== reloaded.pid);

    await writeFile(join(root, 'config', 'api-keys.json'), '{"version":1,"keys":[]}');
    await delay(750);
    assert.equal((await healthWhere(() => true)).pid, wrapperReloaded.pid);

    assert.equal((await command(true).exit)[0], 0, logs.join(''));
    assert.equal((await supervisor.exit)[0], 0, logs.join(''));
    await assert.rejects(request('/health'));
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    assert.equal(logs.join('').match(/AI Gateway: http:\/\//g)?.length, 2);

    foreign = http.createServer((_req, res) => res.end(JSON.stringify({ service: 'nicerouter', build: '1234567890ab', pid: process.pid })));
    foreign.listen(port, '127.0.0.1');
    await once(foreign, 'listening');
    assert.equal((await command().exit)[0], 0, logs.join(''));
    assert.equal((await command(true).exit)[0], 1, logs.join(''));
    assert.equal((await healthWhere(() => true)).pid, process.pid);
  } finally {
    if (foreign?.listening) await new Promise((done) => foreign.close(done));
    if (supervisor && supervisor.child.exitCode === null && supervisor.child.signalCode === null) {
      await command(true).exit;
      await supervisor.exit;
    }
    const target = resolve(root);
    assert.equal(dirname(target), tempRoot);
    assert.ok(basename(target).startsWith('nicerouter watch-'));
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
