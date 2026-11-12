import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';
import { readWorkbuddySession } from './workbuddy-cli.cjs';

const install = 'fixture-install';
const authFile = 'fixture-auth.info';
const syntheticToken = 'workbuddy-fixture-token';
const record = (accessToken) => ({ account: { uid: 42 }, auth: { accessToken } });
const input = (session, options = {}) => ({
  readFile: () => JSON.stringify(session),
  exists: () => false,
  load: () => assert.fail('unexpected crypto module load'),
  readNativeKey: () => assert.fail('unexpected native key request'),
  ...options,
});
const wrapper = { $wbEncrypted: 1, envelope: Buffer.from('synthetic-envelope').toString('base64') };

test('older plaintext session loads before touching crypto modules or the native runtime', () => {
  assert.deepEqual(readWorkbuddySession(install, authFile, input(record(syntheticToken))), {
    userId: '42', token: syntheticToken,
  });
});

test('explicit logout and invalid JSON do not fall through to session loading', () => {
  const signedOut = { exists: (filename) => filename === `${authFile}.logged-out`, readFile: () => assert.fail('read a revoked session') };
  assert.throws(() => readWorkbuddySession(install, authFile, signedOut), /请先在本机登录 WorkBuddy/);
  assert.throws(() => readWorkbuddySession(install, authFile, input(record('bad\r\nheader'))), /请先在本机登录 WorkBuddy/);
  assert.throws(() => readWorkbuddySession(install, authFile, input(record(''), { readFile: () => 'invalid-json-with-private-data' })),
    (error) => /无法读取 WorkBuddy 登录/.test(error.message) && !error.message.includes('private-data'));
});

for (const layout of ['5.5', '5.6', '5.8', '5.9']) {
  test(`encrypted desktop login uses the matching ${layout} crypto module`, () => {
    const key = Buffer.alloc(32, 23);
    const clear = Buffer.from(syntheticToken);
    const seen = [];
    let initialized = false;
    let disposed = false;
    function normalizeAtRestKeyPayload(raw) {
      assert.equal(raw, 'native-test-material');
      return { key };
    }
    function normalizeAtRestBuildKeyCapabilities(raw) {
      assert.ok(initialized);
      return { symmetric: { status: 'available', value: normalizeAtRestKeyPayload(raw) } };
    }
    function parseSupportedEnvelope(buffer) {
      assert.equal(buffer.toString(), 'synthetic-envelope');
      return { parsed: true };
    }
    class AtRestCrypto {
      constructor(material) { assert.equal(material.key, key); }
      open(envelope, framing) {
        assert.deepEqual(envelope, { parsed: true });
        assert.deepEqual(framing, { framing: 'field' });
        return clear;
      }
      dispose() { disposed = true; }
    }
    const initialize = () => { initialized = true; };
    const modules = {
      '5.5': { 'dist.js': { normalizeAtRestKeyPayload, parseSupportedEnvelope, AtRestCrypto } },
      '5.6': { 'app-lifetime-job.js': { applyAppLifetimeJobEnv() {} },
        'process-cpu-sampler.js': { init_dist: initialize, normalizeAtRestBuildKeyCapabilities, parseSupportedEnvelope, AtRestCrypto } },
      '5.8': { 'app-lifetime-job.js': { D: initialize, G: normalizeAtRestBuildKeyCapabilities, K: parseSupportedEnvelope, R: AtRestCrypto } },
      '5.9': { 'dist.js': { s: initialize, T: normalizeAtRestBuildKeyCapabilities, E: parseSupportedEnvelope,
        get v() { return initialized ? AtRestCrypto : undefined; } } },
    }[layout];
    const options = input(record(wrapper), { load: (filename) => {
      seen.push(basename(filename));
      return modules[basename(filename)];
    }, readNativeKey: () => 'native-test-material' });
    assert.deepEqual(readWorkbuddySession(install, authFile, options), { token: syntheticToken, userId: '42' });
    assert.equal(seen.at(-1), Object.keys(modules).at(-1));
    assert.ok(disposed);
    assert.ok(key.every((byte) => byte === 0));
    assert.ok(clear.every((byte) => byte === 0));
  });
}

test('unknown crypto layouts and corrupt envelopes fail before native key loading', () => {
  const guessedExports = { D: () => assert.fail('must not invoke an unrelated minified export'), G() {}, K() {}, R() {} };
  assert.throws(() => readWorkbuddySession(install, authFile, input(record(wrapper), { load: (file) =>
    basename(file) === 'package.json' ? { version: '5.10.0' } : guessedExports })),
  /WorkBuddy 5\.10\.0 .*credential-runtime-layout/);
  assert.throws(() => readWorkbuddySession(install, authFile, input(record({ ...wrapper, envelope: '==invalid' }))), /登录文件格式无效/);
});

test('unsupported field diagnostics reveal only the validated release and fixed category', () => {
  const unsupported = { ...wrapper, scheme: 'asym-v1', envelope: 'sensitive-value' };
  const load = (file) => {
    assert.equal(basename(file), 'package.json');
    return { version: '5.10.0' };
  };
  assert.throws(() => readWorkbuddySession(install, authFile, input(record(unsupported), { load })),
    { message: 'WorkBuddy 5.10.0 的加密登录读取尚不兼容（auth-field-asymmetric）。' });
  assert.throws(() => readWorkbuddySession(install, authFile, input(record({ envelope: 'sensitive-value' }), {
    load: () => ({ version: 'malformed\r\nsensitive-value' }),
  })), { message: 'WorkBuddy（版本未知） 的加密登录读取尚不兼容（auth-field-wrapper）。' });
});
