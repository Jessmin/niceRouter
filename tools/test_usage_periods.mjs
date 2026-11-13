import assert from 'node:assert/strict';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageLedger, usageAccountKey } from '../src/usage-periods.js';

const dir = await mkdtemp(join(tmpdir(), 'gateway-usage-test-'));
const stateFile = join(dir, 'ledger.json');
let time = Date.parse('2026-11-29T22:00:00+08:00');
const now = () => time;
const account = usageAccountKey('trae', 'private fixture identity');
const other = usageAccountKey('trae', 'other fixture identity');
const qoder = usageAccountKey('qoder', 'private fixture identity');
let ledger = createUsageLedger({ now, stateFile });
const sample = (counters, key = account) => ledger.observe({ account: key, method: 'snapshot', counters });
const values = ({ today, month }) => [today, month];

try {
  assert.deepEqual(values(sample([['batch A', 100], ['expiring batch', 75]])), [null, null]);
  assert.deepEqual(values(sample([['batch A', 105], ['new signup batch', 20]])), [5, 5]);
  assert.deepEqual(values(sample([['batch A', 103], ['new signup batch', 21.25]])), [6.25, 6.25]);
  assert.deepEqual(values(sample([['batch A', 105], ['new signup batch', 21.25]])), [6.25, 6.25]);
  assert.deepEqual(values(sample([['batch A', 999]], other)), [null, null]);
  assert.deepEqual(values(sample([['batch A', 999]], other)), [0, 0]);
  console.log('PASS stable accounts, first observation, expiry, rewards, correction and refresh deduplication');

  time = Date.parse('2026-11-30T00:00:01+08:00');
  assert.deepEqual(values(sample([['batch A', 110]])), [null, 11.25]);
  assert.deepEqual(values(sample([['batch A', 112]])), [2, 13.25]);
  time = Date.parse('2026-12-01T00:00:01+08:00');
  assert.deepEqual(values(sample([['batch A', 150]])), [null, null]);
  assert.deepEqual(values(sample([['batch A', 151]])), [1, 1]);
  console.log('PASS Beijing midnight/month boundaries and ambiguous intervals');

  assert.deepEqual(values(sample([['batch A', 200], ['batch A', null]])), [1, 1]);
  assert.deepEqual(values(sample([['batch A', 220]])), [1, 1]);
  assert.deepEqual(values(sample([])), [1, 1]);
  assert.deepEqual(values(sample([['batch A', 240]])), [1, 1]);
  assert.deepEqual(values(ledger.observe({ account: null, method: 'charges' })), [null, null]);
  console.log('PASS ambiguous or absent counters cannot be bridged or counted');

  const before = ledger.observe({ account: qoder, method: 'charges' });
  assert.deepEqual(values(before), [0, 0]);
  ledger.charge({ account: qoder, amount: 1.25 });
  const saving = ledger.flush();
  ledger.charge({ account: qoder, amount: 0.25 });
  await Promise.all([saving, ledger.flush()]);
  assert.doesNotMatch(await readFile(stateFile, 'utf8'), /private fixture|other fixture|batch A/);
  ledger = createUsageLedger({ now, stateFile });
  const after = ledger.observe({ account: qoder, method: 'charges' });
  assert.deepEqual(values(after), [1.5, 1.5]);
  assert.equal(after.since, before.since);
  const snapshot = sample([['batch A', 243]]);
  assert.deepEqual(values(snapshot), [4, 4]);
  assert.equal(snapshot.method, 'snapshot');
  time = Date.parse('2026-12-02T00:00:01+08:00');
  ledger.charge({ account: qoder, amount: 0.5 });
  assert.deepEqual(values(ledger.observe({ account: qoder, method: 'charges' })), [0.5, 2]);
  ledger.charge({ account: qoder, amount: 3 }, Date.parse('2026-12-01T23:59:59+08:00'));
  ledger.charge({ account: qoder, amount: 100 }, Date.parse('2026-11-30T23:59:59+08:00'));
  await ledger.flush();
  ledger = createUsageLedger({ now, stateFile });
  assert.deepEqual(values(ledger.observe({ account: qoder, method: 'charges' })), [0.5, 5]);
  assert.equal(ledger.observe({ account: qoder, method: 'charges' }).method, 'charges');
  await ledger.flush();
  const olderLedger = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const [, record] of olderLedger.accounts) {
    delete record.todayObserved;
    delete record.monthObserved;
  }
  await writeFile(stateFile, JSON.stringify(olderLedger));
  ledger = createUsageLedger({ now, stateFile });
  assert.deepEqual(values(sample([['batch A', 243]])), [null, 4]);
  console.log('PASS confirmed charges, serialized persistence, restart and midnight');
} finally {
  await unlink(stateFile).catch(() => {});
  await rmdir(dir);
}
