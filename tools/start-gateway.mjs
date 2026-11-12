import { fork, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 8787);
const bind = process.env.HOST || '0.0.0.0';
const host = bind === '0.0.0.0' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
const gatewayUrl = `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
const stateDir = join(root, '.workbuddy');
const stateFile = join(stateDir, `gateway-dev-${port}.json`);

function openGateway() {
  console.log(`AI Gateway: ${gatewayUrl}/`);
  if (process.platform !== 'win32' || process.env.GATEWAY_OPEN_BROWSER === '0') return;
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', `${gatewayUrl}/`], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  browser.on('error', () => console.error(`请在浏览器打开 ${gatewayUrl}/`));
  browser.unref();
}

async function gatewayHealth(pid) {
  try {
    const res = await fetch(`${gatewayUrl}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
    if (!res.ok) return false;
    const status = await res.json();
    return status.service === 'nicerouter' && Number.isInteger(status.pid)
      && (pid === undefined || status.pid === pid) && /^[0-9a-f]{12}$/.test(status.build);
  } catch { return false; }
}

function readState() {
  let raw;
  try { raw = readFileSync(stateFile, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let state;
  try { state = JSON.parse(raw); } catch { throw new Error('开发模式控制文件无效。'); }
  if (state?.version !== 1 || !Number.isSafeInteger(state.pid) || state.pid <= 0
    || !Number.isInteger(state.controlPort) || state.controlPort < 1 || state.controlPort > 65535
    || !/^[0-9a-f]{64}$/.test(state.token)) throw new Error('开发模式控制文件无效。');
  return { ...state, raw };
}

async function controlRequest(state, stop = false) {
  try {
    const res = await fetch(`http://127.0.0.1:${state.controlPort}/${stop ? 'stop' : 'status'}`, {
      method: stop ? 'POST' : 'GET', headers: { authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(stop ? 10000 : 1000), redirect: 'error',
    });
    const result = res.ok && await res.json();
    return result?.pid === state.pid && result?.stopped === stop;
  } catch { return false; }
}

function removeState(raw) {
  try { if (readFileSync(stateFile, 'utf8') === raw) unlinkSync(stateFile); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

async function runChild() {
  const { server } = await import('../src/server.js');
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    server.close(() => { if (process.connected) process.disconnect(); });
  }
  process.on('message', (message) => { if (message === 'close') close(); });
  process.on('disconnect', close);
  if (!process.connected) close();
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`端口 ${port} 已被占用。`);
    else console.error(`AI Gateway 启动失败 (${error.code || 'unknown'})`);
    process.exitCode = 1;
    process.send?.({ error: error.code }, () => { if (process.connected) process.disconnect(); });
  });
  const ready = () => { if (process.connected && !closing) process.send('ready', () => {}); };
  if (server.listening) ready();
  else server.once('listening', ready);
}

async function stopGateway() {
  const state = readState();
  if (state && await controlRequest(state, true)) {
    console.log(`已停止端口 ${port} 的开发网关。`);
    return;
  }
  if (await gatewayHealth()) throw new Error(`端口 ${port} 上的网关是从其他入口启动的，请在原启动窗口停止。`);
  if (state && processAlive(state.pid)) throw new Error('开发网关仍在运行，暂时无法连接控制进程。');
  if (state) removeState(state.raw);
  console.log(`端口 ${port} 没有由 start.bat 启动的网关。`);
}

async function startGateway() {
  const state = readState();
  if (state && await controlRequest(state)) {
    console.log(`端口 ${port} 已在开发模式运行。`);
    openGateway();
    return;
  }
  if (await gatewayHealth()) {
    console.log(`端口 ${port} 上的网关是从其他入口启动的，停止后再运行 start.bat 可开启开发模式。`);
    openGateway();
    return;
  }
  if (state && processAlive(state.pid)) throw new Error('开发网关的控制进程尚未退出，请稍后重试。');
  if (state) removeState(state.raw);

  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const watchers = [];
  let child, reloadTimer, shuttingDown, marker;
  let browserOpened = false;

  function launch() {
    const worker = fork(fileURLToPath(import.meta.url), ['--child'], {
      cwd: root, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const exited = once(worker, 'exit').catch((error) => console.error(`无法启动网关 (${error.code || 'unknown'})`));
    const active = { worker, exited };
    child = active;
    active.exited.then(() => { if (child === active) child = undefined; });
    worker.on('message', async (message) => {
      if (message?.error === 'EADDRINUSE') {
        process.exitCode = 1;
        void shutdown();
      }
      if (message === 'ready' && !browserOpened && await gatewayHealth(worker.pid) && !browserOpened && !shuttingDown) {
        browserOpened = true;
        openGateway();
      }
    });
  }

  async function stopChild() {
    const active = child;
    if (!active) return;
    const { worker, exited } = active;
    const force = setTimeout(() => worker.kill(), 6000);
    if (worker.connected) worker.send('close', () => {});
    try { await exited; } finally { clearTimeout(force); }
  }

  let reload = Promise.resolve();
  function changed() {
    if (shuttingDown) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reload = reload.then(async () => {
        if (shuttingDown) return;
        console.log('检测到源码变更，正在重载网关。');
        await stopChild();
        if (!shuttingDown) launch();
      });
    }, 250);
  }

  function shutdown() {
    shuttingDown ??= (async () => {
      try {
        clearTimeout(reloadTimer);
        for (const watcher of watchers) watcher.close();
        await stopChild();
        if (marker) removeState(marker);
      } catch (error) {
        console.error(`网关停止后无法清理控制状态 (${error.code || 'unknown'})。`);
        process.exitCode = 1;
      } finally {
        control.close();
      }
    })();
    return shuttingDown;
  }

  const control = http.createServer({ requestTimeout: 10000, keepAliveTimeout: 1 }, async (req, res) => {
    const auth = Buffer.from(req.headers.authorization || '');
    if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) {
      res.writeHead(403).end();
      return;
    }
    const stop = req.method === 'POST' && req.url === '/stop';
    if (!stop && (req.method !== 'GET' || req.url !== '/status')) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (stop) await shutdown();
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ pid: process.pid, stopped: stop }));
    } catch {
      res.writeHead(500).end();
    }
  });

  try {
    control.listen(0, '127.0.0.1');
    await once(control, 'listening');
    const record = JSON.stringify({ version: 1, pid: process.pid, controlPort: control.address().port, token });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(stateFile, record, { flag: 'wx', mode: 0o600 });
    marker = record;
    for (const [dir, recursive, pattern] of [
      ['src', true, /\.(?:js|mjs|cjs|json)$/i],
      ['tools', false, /^workbuddy-cli\.cjs$/i],
      ['config', false, /^(?:models(?:\.[a-z0-9-]+)?|trae-payload)\.json$/i],
    ]) {
      const watcher = watch(join(root, dir), { recursive }, (_event, file) => {
        if (file && pattern.test(file)) changed();
      });
      watcher.on('error', (error) => {
        console.error(`无法继续监听 ${dir}: ${error.code || 'unknown'}`);
        process.exitCode = 1;
        void shutdown();
      });
      watchers.push(watcher);
    }
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    console.log(`AI Gateway 开发模式，监听源码变更，端口 ${port}。`);
    launch();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

try {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1 到 65535 之间。');
  if (process.argv[2] === '--child') await runChild();
  else if (process.argv[2] === '--stop') await stopGateway();
  else await startGateway();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
