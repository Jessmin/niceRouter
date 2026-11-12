import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const validAmount = (value) => Number.isFinite(value) && value >= 0;
const validKey = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const period = (time) => new Date(time + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
const emptyPeriods = () => ({ today: null, month: null, since: null });

// Adapters attach private observation metadata without adding account or pack IDs to the API.
export const creditObservation = Symbol('credit observation');

export function usageAccountKey(provider, identity) {
  if (typeof identity !== 'string' && !Number.isSafeInteger(identity)) return null;
  if (!String(identity).trim()) return null;
  return createHash('sha256').update(JSON.stringify([provider, String(identity)])).digest('hex');
}

function countersByKey(counters) {
  const entries = new Map(), ambiguous = new Set();
  for (const row of Array.isArray(counters) ? counters : []) {
    if (!Array.isArray(row)) continue;
    const [key, amount] = row;
    if (typeof key !== 'string' || !key) continue;
    const hash = usageAccountKey('credit-counter', key);
    if (entries.has(hash)) ambiguous.add(hash);
    entries.set(hash, validAmount(amount) ? amount : null);
  }
  for (const key of ambiguous) entries.delete(key);
  for (const [key, value] of entries) if (value === null) entries.delete(key);
  return entries;
}

/** Track only received charges or positive movements of comparable cumulative counters. */
export function createUsageLedger({ stateFile, now = Date.now, log = () => {} } = {}) {
  const accounts = new Map();
  let writes = Promise.resolve();
  let needsSave = false;
  try {
    if (stateFile) {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.accounts)) throw new Error('invalid usage ledger');
      for (const [key, item] of saved.accounts.slice(-64)) {
        if (validKey(key) && item && ['snapshot', 'charges'].includes(item.method)
          && Number.isFinite(Date.parse(item.since)) && /^\d{4}-\d{2}-\d{2}$/.test(item.day)
          && validAmount(item.today) && validAmount(item.month) && validAmount(item.at) && Array.isArray(item.counters)) {
          accounts.set(key, item);
        }
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') log('本地积分统计文件读取失败，将从新样本开始');
  }

  function loadAccount(account, method, at) {
    const existing = accounts.get(account);
    if (existing?.method === method) return existing;
    return { method, since: new Date(at).toISOString(), at, day: period(at), today: 0, month: 0, counters: [] };
  }

  function saveAccount(account, record, at, amount) {
    const day = period(at);
    const sameDay = record.day === day;
    const sameMonth = record.day.slice(0, 7) === day.slice(0, 7);
    const direct = record.method === 'charges';
    record.today = (sameDay ? record.today : 0) + (sameDay || direct ? amount : 0);
    record.month = (sameMonth ? record.month : 0) + (sameMonth || direct ? amount : 0);
    record.day = day;
    record.at = at;
    accounts.delete(account);
    accounts.set(account, record);
    if (accounts.size > 64) accounts.delete(accounts.keys().next().value);
    needsSave = true;
  }

  function get(account) {
    const record = accounts.get(account);
    if (!record) return emptyPeriods();
    const day = period(now());
    const normalize = (value) => Number(value.toFixed(8));
    return {
      today: record.day === day ? normalize(record.today) : 0,
      month: record.day.slice(0, 7) === day.slice(0, 7) ? normalize(record.month) : 0,
      since: record.since,
    };
  }

  function observe({ account, method, counters } = {}, at = now()) {
    if (!validKey(account) || !['snapshot', 'charges'].includes(method)) return emptyPeriods();
    const record = loadAccount(account, method, at);
    if (at < record.at) return get(account);
    if (method === 'charges') {
      if (accounts.get(account) !== record) saveAccount(account, record, at, 0);
      return get(account);
    }

    const current = countersByKey(counters);
    if (!current.size && accounts.get(account) !== record) return get(account);
    const previous = new Map(record.counters);
    let added = 0;
    for (const [key, amount] of current) {
      if (!previous.has(key)) continue;
      const before = previous.get(key);
      // A downward correction must not become an artificial charge when the counter rebounds.
      if (amount < before) current.set(key, before);
      else added += amount - before;
    }
    record.counters = [...current];
    saveAccount(account, record, at, added);
    return get(account);
  }

  function charge({ account, amount } = {}, at = now()) {
    if (!validKey(account) || !validAmount(amount)) return;
    const record = loadAccount(account, 'charges', at);
    // Concurrent requests may finish flushing in a different order than their terminal events.
    if (period(at) < record.day) return;
    saveAccount(account, record, Math.max(at, record.at), amount);
  }

  function flush() {
    if (!stateFile || !needsSave) return writes;
    needsSave = false;
    const data = JSON.stringify({ version: 1, accounts: [...accounts] }) + '\n';
    writes = writes.then(async () => {
      const temp = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(stateFile), { recursive: true });
        await writeFile(temp, data, { mode: 0o600 });
        await rename(temp, stateFile);
      } finally {
        await unlink(temp).catch(() => {});
      }
    }).catch(() => {
      needsSave = true;
      log('本地积分统计写入失败，下次更新会重试');
    });
    return writes;
  }

  return { observe, charge, flush };
}
