import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const KEY_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MANAGED_KEY = /^sk-nr-[A-Za-z0-9_-]{43}$/;
const KEY_PREFIX = /^sk-nr-[A-Za-z0-9_-]{8}$/;
const KEY_HASH = /^[0-9a-f]{64}$/;

const hashKey = (key) => createHash('sha256').update(key).digest();
const validKey = (key) => typeof key === 'string' && key.length > 0 && key.length <= 4096 && !/[\s\u0000-\u001f\u007f]/u.test(key);
const validName = (name) => typeof name === 'string' && name === name.trim() && name.length > 0
  && name.length <= 80 && !/[\u0000-\u001f\u007f]/u.test(name);
const publicEntry = ({ id, name, createdAt, prefix }) => ({ id, name, createdAt, prefix });

function storageError(action) {
  return Object.assign(new Error(`无法${action} API 密钥配置。`), { code: 'api_key_storage_error' });
}

function loadKeys(file) {
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw storageError('读取');
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) throw storageError('读取');
    const state = JSON.parse(buffer.toString('utf8', 0, length));
    if (state?.version !== 1 || !Array.isArray(state.keys)) throw storageError('读取');
    const ids = new Set();
    return state.keys.map((entry) => {
      const { id, name, createdAt, prefix, hash } = entry ?? {};
      if (typeof id !== 'string' || !KEY_ID.test(id) || ids.has(id) || !validName(name)
        || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
        || typeof prefix !== 'string' || !KEY_PREFIX.test(prefix)
        || typeof hash !== 'string' || !KEY_HASH.test(hash)) throw storageError('读取');
      ids.add(id);
      return { id, name, createdAt, prefix, hash };
    });
  } catch (error) {
    if (descriptor === undefined && error?.code === 'ENOENT') return [];
    throw storageError('读取');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function saveKeys(file, keys) {
  const data = JSON.stringify({ version: 1, keys }, null, 2) + '\n';
  if (Buffer.byteLength(data) > MAX_FILE_BYTES) throw storageError('保存');
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, data, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, file);
  } catch {
    throw storageError('保存');
  } finally {
    try { unlinkSync(temporary); } catch { /* The temporary file was renamed or never written. */ }
  }
}

export function createApiKeyStore({ file, legacyKey = '' }) {
  const legacyHash = validKey(legacyKey) ? hashKey(legacyKey) : null;
  return {
    list() {
      return loadKeys(file).map(publicEntry);
    },
    create(name) {
      const label = typeof name === 'string' ? name.trim() : '';
      if (!validName(label)) throw new TypeError('密钥名称应包含 1 至 80 个字符。');
      const keys = loadKeys(file);
      const key = 'sk-nr-' + randomBytes(32).toString('base64url');
      const entry = { id: randomUUID(), name: label, createdAt: new Date().toISOString(), prefix: key.slice(0, 14) };
      keys.push({ ...entry, hash: hashKey(key).toString('hex') });
      saveKeys(file, keys);
      return { key, entry };
    },
    revoke(id) {
      if (typeof id !== 'string' || !KEY_ID.test(id)) return false;
      const keys = loadKeys(file);
      const remaining = keys.filter((entry) => entry.id !== id);
      if (remaining.length === keys.length) return false;
      saveKeys(file, remaining);
      return true;
    },
    authenticate(key) {
      if (!validKey(key)) return false;
      const managed = MANAGED_KEY.test(key);
      if (!legacyHash && !managed) return false;
      const hash = hashKey(key);
      if (legacyHash && timingSafeEqual(legacyHash, hash)) return true;
      if (!managed) return false;
      try {
        return loadKeys(file).some((entry) => timingSafeEqual(Buffer.from(entry.hash, 'hex'), hash));
      } catch {
        return false;
      }
    },
  };
}
