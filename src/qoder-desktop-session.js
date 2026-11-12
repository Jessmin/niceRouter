import { createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { spawnSync } from 'node:child_process';
import { desktopInstall } from './desktop-installs.js';

export const QODER_OPENAPI_ORIGINS = Object.freeze({
  qoder: 'https://openapi.qoder.com.cn',
  'qoder-intl': 'https://openapi.qoder.sh',
});

const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$state = Get-Content -LiteralPath $env:QODER_AUTH_LOCAL_STATE -Raw | ConvertFrom-Json
$raw = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
if ($raw.Length -le 5 -or [Text.Encoding]::ASCII.GetString($raw, 0, 5) -ne 'DPAPI') {
  throw 'Unsupported desktop key format'
}
$wrapped = [byte[]]($raw[5..($raw.Length - 1)])
$key = [Security.Cryptography.ProtectedData]::Unprotect($wrapped, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
try { [Console]::Write([Convert]::ToBase64String($key)) }
finally { [Array]::Clear($key, 0, $key.Length) }
`;

function unprotectWindowsKey(localState, { timeoutMs }) {
  if (process.platform !== 'win32') throw new Error('Qoder 桌面凭据刷新需要在 Windows 上运行');
  const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
    env: { ...process.env, QODER_AUTH_LOCAL_STATE: localState },
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    if (result.status !== 0 || !result.stdout?.length) {
      throw new Error('无法以当前 Windows 用户解开 Qoder 登录，请确认已登录目标桌面客户端');
    }
    const key = Buffer.from(result.stdout.toString('ascii').trim(), 'base64');
    if (key.length !== 32) {
      key.fill(0);
      throw new Error('Qoder 桌面密钥格式不受支持');
    }
    return key;
  } finally {
    result.stdout?.fill(0);
    result.stderr?.fill(0);
  }
}

export function qoderDesktopProfile(provider, env = process.env, home = homedir()) {
  const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
  if (provider === 'qoder') {
    return env.QODER_USER_DATA || env.QODER_CN_USER_DATA || join(roaming, 'com.qodercn.app.stable');
  }
  return env.QODER_INTL_USER_DATA || join(roaming, 'com.qoder.app.stable');
}

function sessionExpiry(session) {
  return typeof session?.expiresAt === 'string' ? Date.parse(session.expiresAt) : NaN;
}

export function configuredQoderToken(envToken, session) {
  if (envToken) return envToken;
  return sessionExpiry(session) <= Date.now() ? '' : session?.token || '';
}

/** Reuse desktop DPAPI as the same Windows user and retain the minimum runtime fields. */
export function readQoderDesktopSession(profile, { unprotectKey = unprotectWindowsKey, timeoutMs = 15000 } = {}) {
  let raw;
  try { raw = readFileSync(join(profile, 'auth.v1.dat')); }
  catch { throw new Error('未找到 Qoder 桌面登录记录，请打开对应客户端并登录'); }
  if (raw.length <= 31 || raw.subarray(0, 3).toString('ascii') !== 'v10') {
    throw new Error('Qoder 桌面登录记录格式不受支持');
  }
  const key = unprotectKey(join(profile, 'Local State'), { timeoutMs });
  let auth, clear;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(3, 15));
    decipher.setAuthTag(raw.subarray(-16));
    clear = Buffer.concat([decipher.update(raw.subarray(15, -16)), decipher.final()]);
    auth = JSON.parse(clear.toString('utf8'));
  } catch {
    throw new Error('Qoder 登录记录解密失败，请在目标机以当前 Windows 用户重新登录');
  } finally {
    key.fill(0);
    clear?.fill(0);
  }
  if (typeof auth?.token !== 'string' || !auth.token || /[\s\u0000-\u001f\u007f]/u.test(auth.token)) {
    throw new Error('Qoder 桌面未提供可用的访问令牌，请重新登录');
  }
  const expiry = sessionExpiry(auth);
  if (Number.isFinite(expiry) && expiry <= Date.now()) throw new Error('Qoder 桌面登录已过期，请先在客户端续期');
  const id = auth.user?.id;
  const user = (typeof id === 'string' && id.trim()) || Number.isSafeInteger(id) ? { id } : {};
  return { token: auth.token, expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : '', user };
}

function sameWindowsPath(actual, expected) {
  return !!expected && typeof actual === 'string' && win32.isAbsolute(actual)
    && win32.normalize(actual).toLowerCase() === win32.normalize(expected).toLowerCase();
}

export function discoverQoderDesktopSessions(gateway, {
  env = process.env,
  platform = process.platform,
  home = homedir(),
  runtime = process.execPath,
  install = desktopInstall,
  readSession = readQoderDesktopSession,
} = {}) {
  if (platform !== 'win32' || env.AUTO_DISCOVER_DESKTOP_AUTH === '0') return;

  for (const cfg of [gateway.qoder, gateway.qoderIntl]) {
    const { provider } = cfg;
    if (cfg.token || cfg.openapiBase !== QODER_OPENAPI_ORIGINS[provider]) continue;
    try {
      // Intl passes the token to its worker over stdin. Match the packaged worker
      // independently of overrides and use the running Node executable.
      const installEnv = cfg.sdkHostToken ? { ...env, QODER_INTL_WORKER: undefined } : env;
      const desktop = install(provider, { env: installEnv, platform, home });
      if (!desktop?.workerPath) continue;
      if (cfg.sdkHostToken && (!sameWindowsPath(cfg.workerPath, desktop.workerPath) || !sameWindowsPath(cfg.exePath, runtime))) continue;

      const session = readSession(qoderDesktopProfile(provider, env, home), { timeoutMs: 3500 });
      cfg.token = session.token;
      cfg.desktopSession = session;
    } catch { /* Missing, unreadable, or expired sessions leave only this provider unconfigured. */ }
  }
}
