/** Offline scheduler checks. Fake adapters only; no product requests or claims. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createAutoCheckin } from '../src/auto-checkin.js';

const testDirectory = await mkdtemp(join(tmpdir(), 'auto-checkin-test-'));
const originalEnv = process.env.AUTO_CHECKIN_ENABLED;
process.env.AUTO_CHECKIN_ENABLED = '0';
const fixtures = [];
let clock = Date.parse('2026-11-04T01:59:00Z'); // Beijing 09:59.
const now = () => clock;
const make = (options) => {
  const scheduler = createAutoCheckin({ enabled: true, now, ...options });
  fixtures.push(scheduler);
  return scheduler;
};
function adapter(status, result = { ok: true, claimed: [{ ok: true }] }) {
  const calls = { status: 0, claim: 0 };
  return { calls, checkin: async (opts) => {
    if (opts.action === 'claim') { calls.claim++; return typeof result === 'function' ? result() : result; }
    calls.status++;
    return typeof status === 'function' ? status() : status;
  } };
}
const eligible = { supported: true, claimable: true, done: false };

try {
  // The environment switch disables both startup and explicit scheduler runs.
  let providerReads = 0;
  const disabled = createAutoCheckin({ getProviders: () => { providerReads++; return []; } });
  await disabled.start(); await disabled.run();
  assert.equal(providerReads, 0);
  assert.equal(disabled.status().enabled, false);
  console.log('PASS environment disable');

  let release, entered;
  const waiting = new Promise((done) => { release = done; });
  const began = new Promise((done) => { entered = done; });
  let statusCalls = 0, claimCalls = 0;
  const sharedAdapter = { checkin: async (opts) => {
    if (opts.action === 'claim') { claimCalls++; return { ok: true, after: { done: true } }; }
    statusCalls++; entered(); await waiting; return eligible;
  } };
  const shared = make({ getProviders: () => [
    { name: 'solo', accountKey: 'trae', adapter: sharedAdapter },
    { name: 'trae', accountKey: 'trae', adapter: sharedAdapter },
  ] });
  const running = shared.run();
  await began;
  assert.strictEqual(shared.run(), running);
  assert.equal(shared.status().providers.trae.phase, 'checking');
  release(); await running;
  assert.equal(statusCalls, 1); assert.equal(claimCalls, 1);
  assert.equal(shared.status().providers.solo.accountKey, 'trae');
  assert.equal(shared.status().providers.trae.phase, 'signed');
  console.log('PASS global overlap and shared-account deduplication');

  const stateFile = join(testDirectory, 'state.json');
  const qoder = adapter(eligible);
  const persistent = make({ stateFile, getProviders: () => [{ name: 'qoder', accountKey: 'qoder', resetHour: 10, adapter: qoder }] });
  await persistent.run(); await persistent.run();
  assert.deepEqual(qoder.calls, { status: 2, claim: 1 });
  assert.equal(persistent.status().providers.qoder.done, true);
  assert.equal(persistent.status().running, false);
  const restartedAdapter = adapter(eligible);
  const restarted = make({ stateFile, getProviders: () => [{ name: 'qoder', accountKey: 'qoder', resetHour: 10, adapter: restartedAdapter }] });
  await restarted.run();
  assert.deepEqual(restartedAdapter.calls, { status: 1, claim: 0 });
  assert.ok(restarted.status().providers.qoder.lastSuccessAt);
  console.log('PASS repeated ticks and restart query before deduplicating claims');

  clock = Date.parse('2026-11-04T02:00:00Z');
  await restarted.run();
  assert.equal(restartedAdapter.calls.claim, 1);
  clock = Date.parse('2026-11-04T16:00:00Z'); // Beijing midnight; Qoder must wait for 10:00.
  await restarted.run();
  assert.equal(restartedAdapter.calls.claim, 1);
  clock = Date.parse('2026-11-05T02:00:00Z');
  await restarted.run();
  assert.equal(restartedAdapter.calls.claim, 2);
  console.log('PASS Beijing 10:00 reset and midnight isolation');

  let campaign = 'campaign-one';
  const changed = adapter(() => ({ ...eligible, campaigns: [{ id: campaign, claimable: true }] }));
  const dynamic = make({ getProviders: () => [{ name: 'campaigns', adapter: changed }] });
  await dynamic.run(); campaign = 'campaign-two'; await dynamic.run();
  assert.equal(changed.calls.claim, 2);
  const daily = adapter(() => ({ ...eligible, day: new Date(clock + 8 * 3600000).toISOString().slice(0, 10) }));
  const trae = make({ getProviders: () => [{ name: 'trae', adapter: daily, resetHour: 10 }] });
  await trae.run(); clock = Date.parse('2026-11-05T16:00:00Z'); await trae.run();
  assert.equal(daily.calls.claim, 2);
  console.log('PASS new campaigns and explicit upstream day');

  const noActivity = adapter({ supported: false, claimable: true });
  const noClaim = adapter({ claimSupported: false, claimable: true });
  const notEnabled = adapter({ enabled: false, claimable: true });
  const already = adapter({ done: true, claimable: false });
  const idle = adapter({ done: false, claimable: false });
  const unsupported = make({ getProviders: () => Object.entries({ noActivity, noClaim, notEnabled, already, idle })
    .map(([name, item]) => ({ name, adapter: item })) });
  await unsupported.run();
  for (const item of [noActivity, noClaim, notEnabled, already, idle]) assert.equal(item.calls.claim, 0);
  assert.equal(unsupported.status().providers.noActivity.phase, 'unsupported');
  assert.equal(unsupported.status().providers.already.phase, 'already');
  assert.equal(unsupported.status().providers.idle.phase, 'idle');
  console.log('PASS absent activities, unsupported claims, disabled and already signed');

  let fail = true;
  const retry = adapter(eligible, () => fail ? { ok: false, error: 'temporary error' } : { done: true });
  const good = adapter(eligible);
  const retryScheduler = make({ getProviders: () => [{ name: 'retry', adapter: retry }, { name: 'good', adapter: good }] });
  await retryScheduler.run();
  assert.equal(retryScheduler.status().providers.retry.phase, 'error');
  assert.equal(retryScheduler.status().providers.good.phase, 'signed');
  fail = false; await retryScheduler.run();
  assert.equal(retry.calls.claim, 2); assert.equal(good.calls.claim, 1);
  assert.equal(retryScheduler.status().providers.retry.phase, 'signed');
  const unconfirmed = adapter(eligible, { ok: true });
  const unconfirmedScheduler = make({ getProviders: () => [{ name: 'unconfirmed', adapter: unconfirmed }] });
  await unconfirmedScheduler.run(); await unconfirmedScheduler.run();
  assert.equal(unconfirmedScheduler.status().providers.unconfirmed.phase, 'error');
  assert.equal(unconfirmed.calls.claim, 2);
  console.log('PASS isolated failure, next-tick retry and explicit success proof');

  const secret = 'dt-private-fixture-token';
  const failed = { checkin: async () => { throw new Error(`Bearer ${secret} token=${secret}`); } };
  const privateState = join(testDirectory, 'private-state.json');
  const redact = make({ stateFile: privateState, getProviders: () => [{ name: 'safe-name', adapter: failed }] });
  await redact.run();
  const persisted = await readFile(privateState, 'utf8');
  assert.equal(persisted.includes(secret), false);
  assert.equal(JSON.stringify(redact.status()).includes(secret), false);
  assert.match(persisted, /redacted/);
  console.log('PASS credentials excluded from persisted errors and API status');

  let tick, registrations = 0, removals = 0;
  const startupAdapter = adapter(eligible);
  const startup = make({ intervalMs: 900000, getProviders: () => [{ name: 'startup', adapter: startupAdapter }],
    setIntervalFn: (callback, interval) => { registrations++; assert.equal(interval, 900000); tick = callback; return { unref() {} }; },
    clearIntervalFn: () => { removals++; },
  });
  await startup.start(); await startup.start();
  assert.equal(registrations, 1); assert.equal(startupAdapter.calls.claim, 1);
  tick(); await startup.run();
  assert.equal(startupAdapter.calls.status, 2); assert.equal(startupAdapter.calls.claim, 1);
  await startup.stop();
  assert.equal(removals, 1); assert.equal(startup.status().started, false); assert.equal(startup.status().nextRunAt, null);
  console.log('PASS immediate startup, periodic checks and stop');
  console.log('All auto-checkin tests passed. No network was used.');
} finally {
  await Promise.all(fixtures.map((fixture) => fixture.stop()));
  if (originalEnv == null) delete process.env.AUTO_CHECKIN_ENABLED;
  else process.env.AUTO_CHECKIN_ENABLED = originalEnv;
  const absolute = resolve(testDirectory);
  assert.equal(dirname(absolute), resolve(tmpdir()));
  assert.ok(basename(absolute).startsWith('auto-checkin-test-'));
  await rm(absolute, { recursive: true, force: true });
}
