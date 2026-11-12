import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const DEFAULT_INTERVAL = 15 * 60 * 1000;
const PHASES = new Set(['signed', 'already', 'idle', 'unsupported', 'error', 'checking', 'claiming']);
const TIME_FIELDS = ['lastCheckedAt', 'lastAttemptAt', 'lastSuccessAt', 'lastFinishedAt'];

function safeError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\b(Bearer|Cloud-IDE-JWT)\s+[^\s"',;]+/gi, '$1 [redacted]')
    .replace(/\b(?:dt|drt|jt|sk)-[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/((?:access_?token|refresh_?token|authorization|api[_-]?key|token)\s*[:=]\s*)["']?[^"'\s,;]+/gi, '$1[redacted]')
    .slice(0, 500);
}

function timestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function cleanRecord(key, value = {}) {
  const record = {
    accountKey: key,
    providers: Array.isArray(value.providers) ? value.providers.filter((name) => typeof name === 'string').slice(0, 32) : [],
    phase: PHASES.has(value.phase) && !['checking', 'claiming'].includes(value.phase) ? value.phase : 'idle',
    done: typeof value.done === 'boolean' ? value.done : null,
    claimable: typeof value.claimable === 'boolean' ? value.claimable : null,
    lastError: value.lastError ? safeError(value.lastError) : null,
    lastClaimKey: typeof value.lastClaimKey === 'string' && /^[a-f0-9]{64}$/.test(value.lastClaimKey) ? value.lastClaimKey : null,
  };
  for (const field of TIME_FIELDS) record[field] = timestamp(value[field]);
  return record;
}

function claimKey(checkin, provider, currentTime) {
  const resetHour = Number.isFinite(provider.resetHour) ? Math.max(0, Math.min(23, provider.resetHour)) : 0;
  const day = typeof checkin.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(checkin.day)
    ? checkin.day
    : new Date(currentTime + (8 - resetHour) * 60 * 60 * 1000).toISOString().slice(0, 10);
  const campaigns = (Array.isArray(checkin.campaigns) ? checkin.campaigns : [])
    .filter((campaign) => campaign?.claimable)
    .map((campaign) => [campaign.id || campaign.key || '', campaign.endAt || ''])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return createHash('sha256').update(JSON.stringify({ day, campaigns })).digest('hex');
}

/**
 * Built-in personal-account scheduler. Provider entries are
 * {name, adapter, accountKey, resetHour?}; accountKey must be a non-secret ID.
 * Every run reads upstream status before any explicitly selected claim.
 */
export function createAutoCheckin({
  getProviders,
  stateFile,
  intervalMs = DEFAULT_INTERVAL,
  enabled = process.env.AUTO_CHECKIN_ENABLED !== '0',
  log = () => {},
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof getProviders !== 'function') throw new TypeError('getProviders is required');
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL;
  const accounts = new Map();
  let bindings = new Map();
  let timer = null, started = false, inFlight = null;
  let lastRunAt = null, lastFinishedAt = null, nextRunAt = null, lastError = null, persistenceError = null;
  let persistence = Promise.resolve();
  const iso = () => new Date(now()).toISOString();
  const report = (message) => { try { log(message); } catch { /* Logging must not stop claims for other accounts. */ } };

  if (stateFile) {
    try {
      const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (saved.version !== 1 || !saved.accounts || typeof saved.accounts !== 'object') throw new Error('Unsupported auto-checkin state format');
      lastRunAt = timestamp(saved.lastRunAt);
      lastFinishedAt = timestamp(saved.lastFinishedAt);
      for (const [key, value] of Object.entries(saved.accounts).slice(0, 256)) {
        if (!value || typeof value !== 'object') continue;
        const record = cleanRecord(key, value);
        accounts.set(key, record);
        for (const name of record.providers) bindings.set(name, key);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') persistenceError = safeError(error);
    }
  }

  const publicRecord = (record) => {
    const { lastClaimKey: _key, providers: _names, ...visible } = record;
    return { ...visible };
  };
  function status() {
    return {
      enabled: Boolean(enabled), started, running: Boolean(inFlight), intervalMs: interval,
      lastRunAt, lastFinishedAt, nextRunAt, lastError, persistenceError,
      accounts: Object.fromEntries([...accounts].map(([key, record]) => [key, { ...publicRecord(record), providers: [...record.providers] }])),
      providers: Object.fromEntries([...bindings].map(([name, key]) => [name, publicRecord(accounts.get(key))])),
    };
  }

  function persist() {
    if (!stateFile) return Promise.resolve();
    // All transitions use one write queue, even when accounts are checked in parallel.
    const data = JSON.stringify({ version: 1, lastRunAt, lastFinishedAt, accounts: Object.fromEntries(accounts) }, null, 2) + '\n';
    persistence = persistence.then(async () => {
      const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await mkdir(dirname(stateFile), { recursive: true });
        await writeFile(temporary, data, { mode: 0o600 });
        await rename(temporary, stateFile);
        persistenceError = null;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }).catch((error) => {
      persistenceError = safeError(error);
      report(`Auto-checkin state: ${persistenceError}`);
    });
    return persistence;
  }

  async function checkAccount(group) {
    const record = accounts.get(group.accountKey);
    const adapter = group.adapter;
    if (typeof adapter?.checkin !== 'function') {
      record.phase = 'unsupported'; record.claimable = false; record.lastError = null;
      record.lastFinishedAt = iso();
      await persist();
      return;
    }
    try {
      record.phase = 'checking';
      await persist();
      const checkin = await adapter.checkin({});
      record.lastCheckedAt = iso();
      record.done = typeof checkin?.done === 'boolean' ? checkin.done : null;
      record.claimable = typeof checkin?.claimable === 'boolean' ? checkin.claimable : null;
      record.lastError = null;
      if (!checkin || checkin.supported === false || checkin.claimSupported === false || checkin.enabled === false) {
        record.phase = 'unsupported';
      } else if (checkin.error || checkin.ok === false) {
        throw new Error(checkin.error || 'Upstream check-in status failed');
      } else if (checkin.done === true) {
        record.phase = 'already';
      } else if (checkin.claimable !== true) {
        record.phase = 'idle';
      } else {
        const key = claimKey(checkin, group, now());
        if (record.lastClaimKey === key) {
          // A successful same-period claim can precede an upstream status refresh.
          record.phase = 'signed'; record.done = true; record.claimable = false;
        } else {
          record.phase = 'claiming'; record.lastAttemptAt = iso();
          await persist();
          const result = await adapter.checkin({ action: 'claim', expectedStatus: checkin });
          const confirmed = result && result.ok !== false && (result.after?.done === true || result.done === true
            || (Array.isArray(result.claimed) && result.claimed.some((claim) => claim?.ok === true)));
          if (!confirmed) throw new Error(result?.error || 'Check-in claim was not confirmed successful; retry on the next check');
          record.lastClaimKey = key; record.lastSuccessAt = iso();
          record.done = true; record.claimable = false;
          record.phase = result.already ? 'already' : 'signed';
          report(`Auto-checkin ${group.accountKey}: ${record.phase}`);
        }
      }
    } catch (error) {
      record.phase = 'error'; record.lastError = safeError(error);
      report(`Auto-checkin ${group.accountKey}: ${record.lastError}`);
    } finally {
      record.lastFinishedAt = iso();
      await persist();
    }
  }

  async function perform() {
    lastRunAt = iso(); lastError = null;
    try {
      const providers = await getProviders();
      const groups = new Map();
      bindings = new Map();
      for (const provider of Array.isArray(providers) ? providers : []) {
        if (!provider || typeof provider.name !== 'string') continue;
        const key = String(provider.accountKey || provider.name);
        bindings.set(provider.name, key);
        if (!groups.has(key)) groups.set(key, { ...provider, accountKey: key, names: [] });
        groups.get(key).names.push(provider.name);
      }
      for (const [key, group] of groups) {
        const record = accounts.get(key) || cleanRecord(key);
        record.providers = group.names;
        accounts.set(key, record);
      }
      await Promise.all([...groups.values()].map(checkAccount));
    } catch (error) {
      lastError = safeError(error);
      report(`Auto-checkin run: ${lastError}`);
    } finally {
      lastFinishedAt = iso();
      await persist();
    }
  }

  function run() {
    if (!enabled) return Promise.resolve(status());
    if (inFlight) return inFlight;
    inFlight = perform().then(() => undefined).finally(() => { inFlight = null; }).then(status);
    return inFlight;
  }

  function start() {
    if (!enabled || started) return inFlight || Promise.resolve(status());
    started = true;
    nextRunAt = new Date(now() + interval).toISOString();
    timer = setIntervalFn(() => {
      nextRunAt = new Date(now() + interval).toISOString();
      void run();
    }, interval);
    timer?.unref?.();
    return run();
  }

  function stop() {
    if (timer != null) clearIntervalFn(timer);
    timer = null; started = false; nextRunAt = null;
    return inFlight || Promise.resolve(status());
  }

  return { start, stop, run, status };
}
