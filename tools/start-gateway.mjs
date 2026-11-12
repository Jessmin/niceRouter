import { spawn } from 'node:child_process';
import { isIP } from 'node:net';
import { config } from '../src/config.js';

const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
const url = `http://${isIP(host) === 6 ? `[${host}]` : host}:${config.port}`;

function openGateway() {
  console.log(`AI Gateway: ${url}/`);
  if (process.platform !== 'win32' || process.env.GATEWAY_OPEN_BROWSER === '0') return;
  const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', `${url}/`], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  browser.on('error', () => console.error(`请在浏览器打开 ${url}/`));
  browser.unref();
}

async function gatewayAlreadyRunning() {
  try {
    const res = await fetch(`${url}/v1/status`, {
      ...(config.gatewayKey && { headers: { authorization: `Bearer ${config.gatewayKey}` } }),
      signal: AbortSignal.timeout(1000),
      redirect: 'error',
    });
    if (!res.ok) return false;
    const status = await res.json();
    return Number.isInteger(status.pid) && /^[0-9a-f]{12}$/.test(status.build) && Array.isArray(status.providers);
  } catch {
    return false;
  }
}

if (await gatewayAlreadyRunning()) {
  openGateway();
} else {
  const { server } = await import('../src/server.js');
  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`端口 ${config.port} 已占用，请检查运行中的程序或在 .env 中改用其他 PORT。`);
    else console.error(`AI Gateway 启动失败 (${error.code || 'unknown'})`);
    process.exitCode = 1;
  });
  if (server.listening) openGateway();
  else server.once('listening', openGateway);
}
