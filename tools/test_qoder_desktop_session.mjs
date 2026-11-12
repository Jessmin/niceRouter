import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  configuredQoderToken,
  discoverQoderDesktopSessions,
  QODER_OPENAPI_ORIGINS,
  qoderDesktopProfile,
  readQoderDesktopSession,
} from '../src/qoder-desktop-session.js';
import { qoderQuota } from '../src/adapters/qoder.js';
import { creditObservation, usageAccountKey } from '../src/usage-periods.js';

const runtime = 'C:\\Program Files\\Node.js\\node.exe';
const cnWorker = 'C:\\Apps\\Qoder CN\\qoder-worker-runtime.obf.mjs';
const intlWorker = 'C:\\Apps\\Qoder\\qoder-worker-runtime.obf.mjs';
const makeGateway = () => ({
  qoder: { provider: 'qoder', openapiBase: QODER_OPENAPI_ORIGINS.qoder, workerPath: cnWorker, token: '' },
  qoderIntl: {
    provider: 'qoder-intl', openapiBase: QODER_OPENAPI_ORIGINS['qoder-intl'], workerPath: intlWorker,
    exePath: runtime, sdkHostToken: true, token: '',
  },
});

function options(overrides = {}) {
  return {
    env: { APPDATA: join('fixture', 'Roaming') },
    platform: 'win32',
    runtime,
    install: (provider) => ({ workerPath: provider === 'qoder' ? cnWorker : intlWorker }),
    ...overrides,
  };
}

test('Windows discovery reads the two profiles independently and keeps the account with its token', () => {
  const gateway = makeGateway();
  const reads = [];
  const sessions = [{ token: 'cn-token', user: { id: 123 } }, { token: 'intl-token', user: { id: 'intl-user' } }];
  discoverQoderDesktopSessions(gateway, options({
    readSession: (profile, { timeoutMs }) => {
      reads.push({ profile, timeoutMs });
      return sessions[reads.length - 1];
    },
  }));
  assert.deepEqual(reads, [
    { profile: join('fixture', 'Roaming', 'com.qodercn.app.stable'), timeoutMs: 3500 },
    { profile: join('fixture', 'Roaming', 'com.qoder.app.stable'), timeoutMs: 3500 },
  ]);
  assert.equal(gateway.qoder.token, 'cn-token');
  assert.equal(gateway.qoderIntl.token, 'intl-token');
  assert.deepEqual(gateway.qoder.desktopSession, sessions[0]);
  assert.deepEqual(gateway.qoderIntl.desktopSession, sessions[1]);
});

test('explicit authorization, custom upstreams, and unsupported hosts skip discovery', () => {
  const gateway = makeGateway();
  gateway.qoder.token = 'explicit-token';
  gateway.qoderIntl.openapiBase = 'https://custom.example';
  const reads = [];
  const readSession = (...args) => { reads.push(args); };
  discoverQoderDesktopSessions(gateway, options({ readSession }));
  discoverQoderDesktopSessions(makeGateway(), options({ env: { AUTO_DISCOVER_DESKTOP_AUTH: '0' }, readSession }));
  discoverQoderDesktopSessions(makeGateway(), options({ platform: 'linux', readSession }));
  assert.equal(gateway.qoder.token, 'explicit-token');
  assert.equal(gateway.qoderIntl.token, '');
  assert.deepEqual(reads, []);
});

test('an expired session file does not mask an active desktop login', () => {
  const expired = { token: 'old-token', expiresAt: '2000-01-01T00:00:00Z' };
  assert.equal(configuredQoderToken('env-token', expired), 'env-token');
  assert.equal(configuredQoderToken('', { ...expired, expiresAt: '2999-01-01T00:00:00Z' }), 'old-token');
  assert.equal(configuredQoderToken('', { ...expired, expiresAt: '' }), 'old-token');
  assert.equal(configuredQoderToken('', { ...expired, expiresAt: 'unknown' }), 'old-token');

  const gateway = makeGateway();
  gateway.qoder.token = configuredQoderToken('', expired);
  gateway.qoderIntl.token = 'explicit-token';
  assert.equal(gateway.qoder.token, '');
  discoverQoderDesktopSessions(gateway, options({ readSession: () => ({ token: 'cn-token', user: {} }) }));
  assert.equal(gateway.qoder.token, 'cn-token');
});

test('Intl checks the packaged worker independently of the environment override', () => {
  const gateway = makeGateway();
  gateway.qoder.token = 'explicit-token';
  gateway.qoderIntl.workerPath = 'C:\\Unverified\\worker.mjs';
  const installs = [];
  const reads = [];
  const opts = options({
    env: { QODER_INTL_WORKER: gateway.qoderIntl.workerPath, QODER_INTL_USER_DATA: 'intl-profile' },
    install: (provider, { env }) => {
      installs.push(env.QODER_INTL_WORKER);
      return { workerPath: env.QODER_INTL_WORKER || intlWorker };
    },
    readSession: (profile) => {
      reads.push(profile);
      return { token: 'intl-token', user: {} };
    },
  });
  discoverQoderDesktopSessions(gateway, opts);
  gateway.qoderIntl.workerPath = intlWorker.toLowerCase().replaceAll('\\', '/');
  gateway.qoderIntl.exePath = 'C:\\Unverified\\node.exe';
  discoverQoderDesktopSessions(gateway, opts);
  assert.equal(gateway.qoderIntl.token, '');
  assert.deepEqual(reads, []);
  gateway.qoderIntl.exePath = runtime;
  discoverQoderDesktopSessions(gateway, opts);
  assert.equal(gateway.qoderIntl.token, 'intl-token');
  assert.deepEqual(installs, [undefined, undefined, undefined]);
  assert.deepEqual(reads, ['intl-profile']);
});

test('a broken CN profile leaves Intl discovery available', () => {
  const gateway = makeGateway();
  discoverQoderDesktopSessions(gateway, options({
    readSession: (profile) => {
      if (profile.endsWith('com.qodercn.app.stable')) throw new Error('cannot decrypt profile');
      return { token: 'intl-token', user: {} };
    },
  }));
  assert.equal(gateway.qoder.token, '');
  assert.equal(gateway.qoderIntl.token, 'intl-token');
  assert.equal(qoderDesktopProfile('qoder', { QODER_USER_DATA: 'first', QODER_CN_USER_DATA: 'second' }), 'first');
  assert.equal(qoderDesktopProfile('qoder', { QODER_CN_USER_DATA: 'second' }), 'second');
});

test('the shared v10 session reader rejects expired or corrupt data and does not write to the profile', (t) => {
  const profile = mkdtempSync(join(tmpdir(), 'nicerouter-qoder-session-'));
  const authFile = join(profile, 'auth.v1.dat');
  const stateFile = join(profile, 'Local State');
  t.after(() => {
    rmSync(authFile, { force: true });
    rmSync(stateFile, { force: true });
    rmdirSync(profile);
  });

  const key = randomBytes(32);
  const seal = (auth) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    return Buffer.concat([Buffer.from('v10'), iv, cipher.update(JSON.stringify(auth)), cipher.final(), cipher.getAuthTag()]);
  };
  const auth = { token: 'test-token', user: { id: 123, username: 'not imported' } };
  const envelope = seal(auth);
  writeFileSync(authFile, envelope);
  writeFileSync(stateFile, '{}');
  const opts = {
    unprotectKey: (path) => {
      assert.equal(path, stateFile);
      return Buffer.from(key);
    },
  };
  assert.deepEqual(readQoderDesktopSession(profile, opts), { token: 'test-token', expiresAt: '', user: { id: 123 } });
  assert.deepEqual(readdirSync(profile).sort(), ['Local State', 'auth.v1.dat']);
  assert.deepEqual(readFileSync(authFile), envelope);
  assert.equal(readFileSync(stateFile, 'utf8'), '{}');

  writeFileSync(authFile, seal({ ...auth, expiresAt: '2000-01-01T00:00:00Z' }));
  assert.throws(() => readQoderDesktopSession(profile, opts), /已过期/);
  envelope[envelope.length - 1] ^= 1;
  writeFileSync(authFile, envelope);
  assert.throws(() => readQoderDesktopSession(profile, opts), /解密失败/);
});

test('quota accounting reuses the account ID only for its matching desktop token', async (t) => {
  const gateway = makeGateway();
  gateway.qoderIntl.token = 'explicit-token';
  discoverQoderDesktopSessions(gateway, options({ readSession: () => ({ token: 'cn-token', user: { id: 123 } }) }));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ userId: '123' }));
  const account = usageAccountKey('qoder', 'uid:123');
  assert.deepEqual((await qoderQuota(gateway.qoder))[creditObservation], { account, method: 'charges' });
  gateway.qoder.token = 'replacement-token';
  const replacement = usageAccountKey('qoder', 'token:replacement-token');
  assert.deepEqual((await qoderQuota(gateway.qoder))[creditObservation], { account: replacement, method: 'charges' });
});
