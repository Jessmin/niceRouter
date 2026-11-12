import { createDecipheriv, createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { openSync, closeSync, readSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAGIC = Buffer.from('DBAUTH1\0');
const MAX_BYTES = 4 * 1024 * 1024;
const COOKIE_DOMAINS = ['.doubao.com', 'doubao.com', '.www.doubao.com', 'www.doubao.com'];
const LOGIN_NAMES = new Set(['sessionid', 'sessionid_ss', 'sid_tt']);
const CHROMIUM_EPOCH = 11644473600000000n;
const SESSION_LIFETIME = 24 * 60 * 60 * 1000;
const cache = new Map();

const authError = (message, code = 'doubao_auth_invalid') => Object.assign(new Error(message), {
  code, status: 401, type: 'authentication_error',
});
const refreshHint = () => authError('豆包登录记录不可用，请登录桌面客户端后刷新本机授权');
const clock = (deps) => typeof deps.now === 'function' ? deps.now() : Date.now();
const fingerprint = (value) => `${value.mtimeMs}:${value.ctimeMs}:${value.size}:${value.ino}`;

export const defaultDoubaoProfileDir = () => join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Doubao', 'User Data');
export const doubaoAuthFile = (cfg = {}) => resolve(cfg.authFile || cfg.outputFile || process.env.DOUBAO_AUTH_FILE
  || join(cfg.rootDir || ROOT, '.workbuddy', 'doubao-auth.dpapi'));

const DPAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$mode = $env:DOUBAO_DPAPI_MODE
try {
  if ($mode -eq 'key') {
    $state = Get-Content -LiteralPath $env:DOUBAO_LOCAL_STATE -Raw -Encoding UTF8 | ConvertFrom-Json
    $raw = [Convert]::FromBase64String($state.os_crypt.encrypted_key)
    if ($raw.Length -le 5 -or [Text.Encoding]::ASCII.GetString($raw, 0, 5) -ne 'DPAPI') { throw 'Unsupported key' }
    $data = [byte[]]($raw[5..($raw.Length - 1)])
  } else {
    $data = [Convert]::FromBase64String([Console]::In.ReadToEnd())
  }
  if ($mode -eq 'protect') {
    $result = [Security.Cryptography.ProtectedData]::Protect($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } elseif ($mode -eq 'key' -or $mode -eq 'unprotect') {
    $result = [Security.Cryptography.ProtectedData]::Unprotect($data, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else { throw 'Unsupported mode' }
  [Console]::Write([Convert]::ToBase64String($result))
} finally {
  if ($data) { [Array]::Clear($data, 0, $data.Length) }
  if ($raw) { [Array]::Clear($raw, 0, $raw.Length) }
  if ($result) { [Array]::Clear($result, 0, $result.Length) }
}
`;

/** DPAPI material travels only through private stdio and stays on this Windows user. */
function dpapi(mode, input = Buffer.alloc(0), localState = '') {
  if (process.platform !== 'win32') return Promise.reject(authError('豆包桌面授权刷新需要当前 Windows 用户', 'doubao_auth_platform'));
  const executable = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DOUBAO_DPAPI_MODE: mode, DOUBAO_LOCAL_STATE: localState },
    });
    const chunks = [];
    let bytes = 0, failed = false;
    const timeout = setTimeout(() => { failed = true; child.kill(); }, 15000);
    child.stderr.resume();
    child.stdin.on('error', () => { failed = true; child.kill(); });
    child.once('error', () => { failed = true; });
    child.stdout.on('data', (data) => {
      bytes += data.length;
      if (bytes > MAX_BYTES * 2) { failed = true; data.fill(0); child.kill(); }
      else chunks.push(data);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      let output;
      try {
        if (failed || code !== 0 || !bytes) throw refreshHint();
        output = Buffer.concat(chunks);
        const text = output.toString('ascii').trim();
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4) throw refreshHint();
        resolveResult(Buffer.from(text, 'base64'));
      } catch { reject(refreshHint()); }
      finally { output?.fill(0); for (const chunk of chunks) chunk.fill(0); }
    });
    child.stdin.end(input.toString('base64'), 'ascii');
  });
}

async function readCookieRows(file, deps) {
  let DatabaseSync = deps.DatabaseSync;
  if (!DatabaseSync) {
    try { ({ DatabaseSync } = await import('node:sqlite')); }
    catch { throw authError('当前 Node.js 不支持读取豆包登录数据库，请使用支持 node:sqlite 的运行时', 'doubao_auth_runtime'); }
  }
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value);
    if (!Number.isSafeInteger(version) || version <= 0) throw refreshHint();
    const columns = new Set(db.prepare('PRAGMA table_info(cookies)').all().map((column) => column.name));
    const required = ['host_key', 'name', 'path', 'is_secure', 'expires_utc', 'value', 'encrypted_value'];
    if (required.some((name) => !columns.has(name))) throw refreshHint();
    const expiry = columns.has('has_expires') ? 'has_expires' : '(expires_utc != 0) AS has_expires';
    const query = db.prepare(`SELECT host_key, name, path, is_secure, expires_utc, value, encrypted_value, ${expiry}
      FROM cookies WHERE host_key IN (?, ?, ?, ?)`);
    query.setReadBigInts(true);
    return { version, rows: query.all(...COOKIE_DOMAINS) };
  } catch (error) {
    if (error?.code === 'doubao_auth_runtime') throw error;
    throw authError('无法只读读取豆包 Cookies，请正常退出豆包后刷新，或用 --cookies 指定可读快照', 'doubao_auth_database');
  } finally { db?.close(); }
}

function validCookie(cookie) {
  return cookie && COOKIE_DOMAINS.includes(cookie.domain)
    && typeof cookie.name === 'string' && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name)
    && typeof cookie.value === 'string' && cookie.value.length <= 32768 && !/[\u0000-\u001f\u007f;]/u.test(cookie.value)
    && typeof cookie.path === 'string' && cookie.path.startsWith('/') && !/[\r\n\u0000]/u.test(cookie.path)
    && typeof cookie.secure === 'boolean' && Number.isSafeInteger(cookie.expiresAtMs) && cookie.expiresAtMs >= 0;
}

function decodeCookie(row, key, version) {
  const encrypted = Buffer.from(row.encrypted_value || []);
  if (!encrypted.length) return typeof row.value === 'string' ? row.value : '';
  const prefix = encrypted.subarray(0, 3).toString('ascii');
  if (prefix === 'v20') throw authError('豆包使用了当前不支持的应用绑定 Cookie 加密格式', 'doubao_auth_app_bound');
  if (!['v10', 'v11'].includes(prefix) || encrypted.length < 31) throw refreshHint();
  let clear;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(3, 15));
    decipher.setAuthTag(encrypted.subarray(-16));
    clear = Buffer.concat([decipher.update(encrypted.subarray(15, -16)), decipher.final()]);
    if (version >= 24) {
      const hostHash = createHash('sha256').update(row.host_key).digest();
      if (clear.length < 32 || !timingSafeEqual(clear.subarray(0, 32), hostHash)) throw refreshHint();
      return clear.subarray(32).toString('utf8');
    }
    return clear.toString('utf8');
  } catch { throw refreshHint(); }
  finally { clear?.fill(0); }
}

async function accountKey(profileDir, cookies) {
  let id;
  try {
    const preferences = JSON.parse(await readFile(join(profileDir, 'Default', 'Preferences'), 'utf8'));
    const value = preferences.saman?.last_user?.user_id;
    if (typeof value === 'string' && value.length && value.length <= 256) id = `uid:${value}`;
  } catch { /* A valid login cookie can still identify this account scope. */ }
  const login = cookies.find((cookie) => LOGIN_NAMES.has(cookie.name) && cookie.value);
  return createHash('sha256').update(`doubao\0${id || `session:${login.value}`}`).digest('hex');
}

/** Refresh from an explicit snapshot or an unlocked, read-only desktop profile. */
export async function refreshDoubaoAuth(options = {}, deps = {}) {
  const profileDir = resolve(options.profileDir || process.env.DOUBAO_USER_DATA || defaultDoubaoProfileDir());
  const cookiesFile = resolve(options.cookiesFile || join(profileDir, 'Default', 'Network', 'Cookies'));
  const file = doubaoAuthFile(options);
  const now = clock(deps);
  const { version, rows } = await (deps.readCookies || readCookieRows)(cookiesFile, deps);
  let key, plain, protectedData, temporary;
  try {
    key = await (deps.unprotectKey || ((path) => dpapi('key', Buffer.alloc(0), path)))(join(profileDir, 'Local State'));
    if (!Buffer.isBuffer(key) || key.length !== 32) throw refreshHint();
    const cookies = [];
    for (const row of rows) {
      if (!COOKIE_DOMAINS.includes(row.host_key)) continue;
      const hasExpiry = row.has_expires === 1n || row.has_expires === 1;
      const expiry = hasExpiry ? Number((BigInt(row.expires_utc) - CHROMIUM_EPOCH) / 1000n) : 0;
      if (hasExpiry && expiry <= now) continue;
      const cookie = { domain: row.host_key, name: row.name, path: row.path, secure: row.is_secure === 1n || row.is_secure === 1,
        expiresAtMs: expiry, value: decodeCookie(row, key, version) };
      if (!validCookie(cookie)) throw refreshHint();
      cookies.push(cookie);
    }
    const loginCookies = cookies.filter((cookie) => LOGIN_NAMES.has(cookie.name) && cookie.value);
    if (!loginCookies.length) throw authError('豆包未提供有效的登录 Cookie，请先在官方客户端登录', 'doubao_auth_missing');
    const expiresAtMs = Math.max(...loginCookies.map((cookie) => cookie.expiresAtMs || now + SESSION_LIFETIME));
    const record = { version: 1, createdAtMs: now, expiresAtMs, accountKey: await accountKey(profileDir, cookies), cookies };
    plain = Buffer.from(JSON.stringify(record));
    if (plain.length > MAX_BYTES / 2) throw refreshHint();
    protectedData = await (deps.protect || ((data) => dpapi('protect', data)))(plain);
    if (!Buffer.isBuffer(protectedData) || !protectedData.length || protectedData.length > MAX_BYTES - MAGIC.length) throw refreshHint();
    await mkdir(dirname(file), { recursive: true });
    temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, Buffer.concat([MAGIC, protectedData]), { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
    temporary = null;
    cache.delete(file);
    return { file, cookieCount: cookies.length, expiresAt: new Date(expiresAtMs).toISOString(), accountKey: record.accountKey };
  } finally {
    key?.fill(0); plain?.fill(0); protectedData?.fill(0);
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

function validateRecord(record) {
  if (!record || record.version !== 1 || !Number.isSafeInteger(record.createdAtMs)
    || !Number.isSafeInteger(record.expiresAtMs) || !/^[a-f0-9]{64}$/.test(record.accountKey || '')
    || !Array.isArray(record.cookies) || !record.cookies.length || !record.cookies.every(validCookie)
    || !record.cookies.some((cookie) => LOGIN_NAMES.has(cookie.name) && cookie.value)) throw refreshHint();
  return record;
}

function cookieHeader(record, value, now) {
  let url;
  try { url = new URL(value); } catch { throw authError('豆包凭据仅用于官方 HTTPS 接口', 'doubao_auth_origin'); }
  if (url.protocol !== 'https:' || !['doubao.com', 'www.doubao.com'].includes(url.hostname)
    || url.username || url.password || url.port && url.port !== '443') {
    throw authError('豆包凭据仅用于官方 HTTPS 接口', 'doubao_auth_origin');
  }
  const matches = record.cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, '');
    const hostMatches = url.hostname === domain || cookie.domain.startsWith('.') && url.hostname.endsWith(`.${domain}`);
    const pathMatches = url.pathname === cookie.path || url.pathname.startsWith(cookie.path)
      && (cookie.path.endsWith('/') || url.pathname[cookie.path.length] === '/');
    return hostMatches && pathMatches && (!cookie.expiresAtMs || cookie.expiresAtMs > now);
  });
  if (record.expiresAtMs <= now || !matches.some((cookie) => LOGIN_NAMES.has(cookie.name) && cookie.value)) {
    throw authError('豆包登录已过期，请在官方客户端登录后刷新授权', 'doubao_auth_expired');
  }
  return matches.sort((a, b) => b.path.length - a.path.length).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/** A fast file-format check; active authorization is validated on getDoubaoAuth. */
export function hasDoubaoAuth(cfg = {}) {
  const file = doubaoAuthFile(cfg);
  let descriptor;
  try {
    const info = statSync(file);
    if (!info.isFile() || info.size <= MAGIC.length || info.size > MAX_BYTES) return false;
    const known = cache.get(file);
    if (known?.fingerprint === fingerprint(info) && known.record?.expiresAtMs <= Date.now()) return false;
    descriptor = openSync(file, 'r');
    const header = Buffer.alloc(MAGIC.length);
    return readSync(descriptor, header, 0, header.length, 0) === header.length && header.equals(MAGIC);
  } catch { return false; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Decrypt once per file version. Cookies are exposed only through origin-checked headers. */
export async function getDoubaoAuth(cfg = {}, deps = {}) {
  const file = doubaoAuthFile(cfg);
  let info;
  try { info = await stat(file); } catch { cache.delete(file); return null; }
  if (!info.isFile() || info.size <= MAGIC.length || info.size > MAX_BYTES) throw refreshHint();
  const identity = fingerprint(info);
  let entry = cache.get(file);
  if (!entry || entry.fingerprint !== identity) {
    entry = { fingerprint: identity, loading: null, record: null };
    entry.loading = (async () => {
      let raw, clear;
      try {
        raw = await readFile(file);
        if (raw.length > MAX_BYTES || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw refreshHint();
        clear = await (deps.unprotect || ((data) => dpapi('unprotect', data)))(raw.subarray(MAGIC.length));
        if (!Buffer.isBuffer(clear) || clear.length > MAX_BYTES) throw refreshHint();
        entry.record = validateRecord(JSON.parse(clear.toString('utf8')));
        return entry.record;
      } catch { if (cache.get(file) === entry) cache.delete(file); throw refreshHint(); }
      finally { raw?.fill(0); clear?.fill(0); }
    })();
    cache.set(file, entry);
  }
  const record = await entry.loading;
  if (record.expiresAtMs <= clock(deps)) return null;
  return { accountKey: record.accountKey, expiresAtMs: record.expiresAtMs,
    cookieHeader: (url) => cookieHeader(record, url, clock(deps)) };
}
