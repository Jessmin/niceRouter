import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { desktopInstall } from './desktop-installs.js';

const CLIENT_ID = 'mcode-public';
const AUDIENCE = 'agent-backend';
const SCOPE = 'agent.default';
const CAP_FILE = 'mcode-auth-lease-v1.cap';
const MAX_FRAME_BYTES = 64 * 1024;
const validToken = (value) => typeof value === 'string' && value.length > 0
  && value.length <= 32 * 1024 && !/[\s\u0000-\u001f\u007f]/u.test(value);

export const miniMaxCodeDataDir = () => resolve(process.env.MINIMAX_CODE_DATA_DIR
  || process.env.MINIMAX_DATA_DIR || process.env.MAVIS_DATA_DIR || join(homedir(), '.minimax'));

export function miniMaxCodeRegion(region = process.env.MINIMAX_CODE_REGION || 'cn') {
  if (region === 'cn') return 'cn';
  if (region === 'global' || region === 'en') return 'global';
  return null;
}

const configuredTimeout = Number(process.env.MINIMAX_CODE_TIMEOUT_MS || 180000);
export const minimaxCodeConfig = Object.freeze({
  enabled: process.env.MINIMAX_CODE_ENABLED !== '0',
  region: miniMaxCodeRegion(),
  dataDir: miniMaxCodeDataDir(),
  installDir: process.env.MINIMAX_CODE_INSTALL_DIR
    || desktopInstall('minimax-code')?.installDir
    || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs', 'MiniMax Code'),
  timeoutMs: Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 180000,
});

function namespace(options) {
  const region = miniMaxCodeRegion(options.region);
  if (!region) return null;
  const dataDir = resolve(options.dataDir || miniMaxCodeDataDir());
  const authHome = join(dataDir, 'auth');
  const suffix = region === 'cn' ? 'cn' : 'en';
  const account = createHash('sha256').update(`${authHome}\0${CLIENT_ID}`).digest('base64url');
  const key = `com.minimax.mcode.oauth.prod.${suffix}\0${account}`;
  return { region, dataDir, key, file: join(authHome, 'prod', suffix, CLIENT_ID, 'auth.json') };
}

function authRecord(ns) {
  if (!ns) return null;
  try {
    const payload = JSON.parse(readFileSync(ns.file, 'utf8'));
    const value = payload.schemaVersion === 1 && Object.hasOwn(payload.records || {}, ns.key)
      ? payload.records[ns.key] : null;
    if (!value || value.schemaVersion !== 1 || value.clientId !== CLIENT_ID || value.tokenType !== 'Bearer'
      || value.audience !== AUDIENCE || !Array.isArray(value.scopes) || !value.scopes.includes(SCOPE)
      || !Number.isFinite(value.expiresAtMs) || !validToken(value.accessToken)) return null;
    return { region: ns.region, accessToken: value.accessToken, expiresAtMs: value.expiresAtMs,
      clientId: value.clientId, audience: value.audience, scopes: [SCOPE] };
  } catch { return null; }
}

/** Read the exact official namespace record. Refresh credentials stay in the app. */
export function readMiniMaxCodeAuth(options = {}) {
  const value = authRecord(namespace(options));
  return value && value.expiresAtMs > Date.now() ? { ...value, source: 'file' } : null;
}

export function hasMiniMaxCodeAuth(options = {}) {
  const ns = namespace(options), value = authRecord(ns);
  return Boolean(value && (value.expiresAtMs > Date.now() || existsSync(join(ns.dataDir, 'run', CAP_FILE))));
}

// The official local owner exposes a v1 length-prefixed lease on a per-data-dir
// socket. The gateway does not become a second OAuth refresh owner.
async function requestLease(dataDir, signal) {
  signal?.throwIfAborted();
  let capability;
  try { capability = readFileSync(join(dataDir, 'run', CAP_FILE), 'utf8').trim(); }
  catch { return null; }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) return null;
  const endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\mcode-auth-lease-' + createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 16)
    : join(dataDir, 'run', 'mcode-auth-lease-v1.sock');
  const requestId = randomUUID();
  const payload = Buffer.from(JSON.stringify({ version: 1, requestId, capability, method: 'lease', minValidityMs: 30000 }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  return new Promise((done) => {
    const socket = createConnection(endpoint);
    let buffer = Buffer.alloc(0), finished = false;
    const finish = (value = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      done(value);
    };
    const abort = () => finish();
    const timer = setTimeout(finish, 2500);
    signal?.addEventListener('abort', abort, { once: true });
    socket.once('error', () => finish());
    socket.once('close', () => finish());
    socket.once('connect', () => socket.write(Buffer.concat([prefix, payload])));
    socket.on('data', (bytes) => {
      if (buffer.length + bytes.length > MAX_FRAME_BYTES + 4) return finish();
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32BE();
      if (!size || size > MAX_FRAME_BYTES) return finish();
      if (buffer.length < size + 4) return;
      try {
        const reply = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
        if (reply.version !== 1 || reply.requestId !== requestId || reply.ok !== true) return finish();
        const result = reply.result;
        if (result?.method !== 'lease' || result.audience !== AUDIENCE || !Array.isArray(result.scopes)
          || !result.scopes.includes(SCOPE) || !validToken(result.accessToken)
          || !Number.isFinite(result.expiresAtMs) || result.expiresAtMs <= Date.now()) return finish();
        finish(result);
      } catch { finish(); }
    });
    if (signal?.aborted) abort();
  });
}

/** A lease carries no region. Match it to the selected namespace before use. */
export async function getMiniMaxCodeAuth(options = {}) {
  options.signal?.throwIfAborted();
  const ns = namespace(options), prior = authRecord(ns);
  if (!prior) return null;
  const leased = await requestLease(ns.dataDir, options.signal).catch(() => null);
  options.signal?.throwIfAborted();
  const current = authRecord(ns);
  if (current && current.expiresAtMs > Date.now()) {
    const matches = leased?.accessToken === current.accessToken && leased.expiresAtMs === current.expiresAtMs;
    return { ...current, source: matches ? 'lease' : 'file' };
  }
  return null;
}

const validDesktopVersion = (value) => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/u.test(value);

function archiveVersion(archive) {
  let fd;
  try {
    fd = openSync(archive, 'r');
    const prefix = Buffer.alloc(16);
    if (readSync(fd, prefix, 0, 16, 0) !== 16) return null;
    const size = prefix.readUInt32LE(12);
    if (size < 2 || size > 16 * 1024 * 1024) return null;
    const header = Buffer.alloc(size);
    if (readSync(fd, header, 0, size, 16) !== size) return null;
    const entry = JSON.parse(header.toString('utf8')).files?.['package.json'];
    const offset = Number(entry?.offset);
    if (entry?.unpacked || !Number.isSafeInteger(offset) || offset < 0
      || !Number.isSafeInteger(entry?.size) || entry.size < 2 || entry.size > 65536) return null;
    const bytes = Buffer.alloc(entry.size);
    const position = 8 + prefix.readUInt32LE(4) + offset;
    if (readSync(fd, bytes, 0, bytes.length, position) !== bytes.length) return null;
    const version = JSON.parse(bytes.toString('utf8')).version;
    return validDesktopVersion(version) ? version : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

let desktopVersionCache;
export function readMiniMaxCodeDesktopVersion(installDir = minimaxCodeConfig.installDir) {
  const archive = join(installDir, 'resources', 'app.asar');
  const manifests = ['app', 'app.asar.unpacked'].map((folder) => join(installDir, 'resources', folder, 'package.json'));
  const exe = join(installDir, 'MiniMax Code.exe');
  const stamps = [archive, ...manifests, exe].map((filename) => {
    try {
      const info = statSync(filename);
      return info.isFile() ? `${info.size}:${info.mtimeMs}` : '';
    } catch { return ''; }
  });
  const stamp = stamps.join('|');
  if (desktopVersionCache?.installDir === installDir && desktopVersionCache.stamp === stamp) return desktopVersionCache.version;
  let version = archiveVersion(archive);
  if (!version && stamps.at(-1)) {
    for (const filename of manifests) {
      try {
        const info = statSync(filename);
        if (!info.isFile() || info.size > 65536) continue;
        const manifest = JSON.parse(readFileSync(filename, 'utf8'));
        if (manifest.name === '@mmx-agent/electron' && validDesktopVersion(manifest.version)) {
          version = manifest.version;
          break;
        }
      } catch { /* Try the other packaged layout. */ }
    }
  }
  desktopVersionCache = { installDir, stamp, version };
  return version;
}
