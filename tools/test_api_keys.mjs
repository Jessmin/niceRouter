import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApiKeyStore } from '../src/api-keys.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'nicerouter-api-keys-'));
  const file = join(dir, 'api-keys.json');
  t.after(() => {
    if (existsSync(file)) unlinkSync(file);
    rmdirSync(dir);
  });
  return { file, dir };
}

test('a new API key is disclosed on creation, and only its hash and label are persisted', (t) => {
  const { file, dir } = fixture(t);
  const store = createApiKeyStore({ file });
  assert.deepEqual(store.list(), []);
  assert.equal(store.authenticate(''), false);
  assert.equal(store.authenticate('unregistered'), false);
  assert.equal(existsSync(file), false);

  const { key, entry } = store.create('  内网 Harness  ');
  assert.match(key, /^sk-nr-[A-Za-z0-9_-]{43}$/);
  assert.equal(entry.name, '内网 Harness');
  assert.equal(entry.prefix, key.slice(0, 14));
  assert.equal(store.authenticate(key), true);
  assert.equal(store.authenticate('Bearer ' + key), false);
  assert.equal(store.authenticate(key + ' '), false);

  const persisted = readFileSync(file, 'utf8');
  const hash = createHash('sha256').update(key).digest('hex');
  assert.equal(persisted.includes(key), false);
  assert.deepEqual(JSON.parse(persisted), { version: 1, keys: [{ ...entry, hash }] });
  assert.deepEqual(store.list(), [entry]);
  assert.deepEqual(readdirSync(dir), ['api-keys.json']);
});

test('multiple keys survive reload, and revoked keys are rejected by an existing store', (t) => {
  const { file } = fixture(t);
  const store = createApiKeyStore({ file });
  const first = store.create('Harness');
  const second = store.create('局域网助手');
  assert.notEqual(first.key, second.key);
  assert.notEqual(first.entry.id, second.entry.id);

  const reloaded = createApiKeyStore({ file });
  assert.equal(reloaded.authenticate(first.key), true);
  assert.equal(reloaded.authenticate(second.key), true);
  assert.equal(reloaded.revoke(first.entry.id), true);
  assert.equal(reloaded.revoke(first.entry.id), false);
  assert.equal(reloaded.revoke('missing'), false);
  assert.equal(store.authenticate(first.key), false);
  assert.equal(store.authenticate(second.key), true);
  assert.deepEqual(store.list(), [second.entry]);
});

test('invalid labels are rejected without modifying disk', (t) => {
  const { file } = fixture(t);
  const store = createApiKeyStore({ file });
  for (const name of [null, '', '   ', 'a'.repeat(81), 'bad\nname']) {
    assert.throws(() => store.create(name), TypeError);
  }
  assert.equal(existsSync(file), false);
});

test('damaged managed configuration fails closed and is preserved for recovery', (t) => {
  const { file } = fixture(t);
  const store = createApiKeyStore({ file, legacyKey: 'legacy-fixture' });
  const created = store.create('managed');
  const corrupted = ['{incomplete', '{"version":2,"keys":[]}', '{"version":1,"keys":[null]}'];
  for (const invalid of corrupted) {
    writeFileSync(file, invalid);
    assert.equal(store.authenticate(created.key), false);
    assert.throws(() => store.list(), { code: 'api_key_storage_error' });
    assert.throws(() => store.create('another'), { code: 'api_key_storage_error' });
    assert.throws(() => store.revoke(created.entry.id), { code: 'api_key_storage_error' });
    assert.equal(readFileSync(file, 'utf8'), invalid);
    assert.equal(store.authenticate('legacy-fixture'), true);
  }
});

test('configured API key is accepted but omitted from the managed key list', (t) => {
  const { file } = fixture(t);
  const store = createApiKeyStore({ file, legacyKey: 'legacy-fixture' });
  assert.equal(store.authenticate('legacy-fixture'), true);
  assert.equal(store.authenticate('legacy-fixturE'), false);
  assert.equal(store.revoke('legacy-fixture'), false);
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(file), false);
});

test('an unavailable storage directory returns a stable error and discloses no key', (t) => {
  const { file } = fixture(t);
  writeFileSync(file, 'a regular file cannot contain a directory');
  const unavailable = createApiKeyStore({ file: join(file, 'api-keys.json') });
  assert.throws(() => unavailable.create('Harness'), { code: 'api_key_storage_error' });
  assert.equal(unavailable.authenticate('unknown'), false);
});
