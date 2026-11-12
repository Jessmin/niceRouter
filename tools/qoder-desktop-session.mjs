import { createDecipheriv, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

function unprotectWindowsKey(localState) {
  if (process.platform !== 'win32') throw new Error('Qoder 桌面凭据刷新需要在 Windows 上运行');
  const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
    env: { ...process.env, QODER_AUTH_LOCAL_STATE: localState }, windowsHide: true, timeout: 15000,
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

/** Reuse desktop DPAPI as the same Windows user and retain the minimum runtime fields. */
export function readQoderDesktopSession(profile, { unprotectKey = unprotectWindowsKey } = {}) {
  let raw;
  try { raw = readFileSync(join(profile, 'auth.v1.dat')); }
  catch { throw new Error('未找到 Qoder 桌面登录记录，请打开对应客户端并登录'); }
  if (raw.length <= 31 || raw.subarray(0, 3).toString('ascii') !== 'v10') {
    throw new Error('Qoder 桌面登录记录格式不受支持');
  }
  const key = unprotectKey(join(profile, 'Local State'));
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
  const expiry = typeof auth.expiresAt === 'string' ? Date.parse(auth.expiresAt) : NaN;
  if (Number.isFinite(expiry) && expiry <= Date.now()) throw new Error('Qoder 桌面登录已过期，请先在客户端续期');
  const id = auth.user?.id;
  const user = (typeof id === 'string' && id.trim()) || Number.isSafeInteger(id) ? { id } : {};
  return { token: auth.token, expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : '', user };
}

export function writeQoderDesktopSession(file, session) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(session, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch {
    throw new Error('保存 Qoder 网关会话失败，请检查目标目录权限');
  } finally {
    try { unlinkSync(temp); } catch { /* Renamed or never created. */ }
  }
}

export function refreshQoderDesktopSession({ provider, profileName, profileOverride, outputFile, command }) {
  let profile = profileOverride || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), profileName);
  let output = outputFile;
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`用法：node ${command} [--user-data <桌面数据目录>] [--output <会话输出文件>]`);
    return;
  }
  try {
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i], value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error('参数需要指定路径，可用 --help 查看用法');
      if (name === '--user-data') profile = resolve(value);
      else if (name === '--output') output = resolve(value);
      else throw new Error('不支持的参数，可用 --help 查看用法');
    }
    const session = readQoderDesktopSession(profile);
    writeQoderDesktopSession(output, session);
    console.log(JSON.stringify({ provider, saved: true, expiresAt: session.expiresAt || null }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
