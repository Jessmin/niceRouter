import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fillTraeDesktopHeaders, readTraeDeviceId, TRAE_CHAT_BASE, TRAE_PAY_BASE } from '../src/trae-desktop-metadata.js';

const fixtureProduct = {
  bootConfig: { agent: { appId: '00000000-0000-0000-0000-000000000001' } },
  date: '2026-11-02T15:37:51.333Z',
  traeVersionCode: '20250325',
  deviceId: '1111111111111111',
  token: 'should-not-import',
};

function fixture(t) {
  const installDir = mkdtempSync(join(tmpdir(), 'nicerouter-trae-metadata-'));
  const resources = join(installDir, 'resources');
  const app = join(resources, 'app');
  const file = join(app, 'product.json');
  mkdirSync(resources);
  mkdirSync(app);
  t.after(() => {
    rmSync(file, { force: true });
    rmdirSync(app);
    rmdirSync(resources);
    rmdirSync(installDir);
  });
  return { file, installDir };
}

function options(installDir) {
  return { base: TRAE_CHAT_BASE + '/', payBase: TRAE_PAY_BASE, readDeviceId: () => '', locate: (name) => {
    assert.equal(name, 'trae');
    return { installDir };
  } };
}

test('Trae fills only the missing application metadata from the installed manifest', (t) => {
  const { file, installDir } = fixture(t);
  writeFileSync(file, '\uFEFF' + JSON.stringify(fixtureProduct));
  const headers = { authorization: 'Cloud-IDE-JWT fixture' };
  fillTraeDesktopHeaders(headers, options(installDir));
  assert.deepEqual(headers, {
    authorization: 'Cloud-IDE-JWT fixture',
    'x-app-id': fixtureProduct.bootConfig.agent.appId,
    'x-ide-version-code': '20261102',
  });
});

test('Trae preserves explicit headers and skips local discovery for custom upstreams', (t) => {
  const { file, installDir } = fixture(t);
  writeFileSync(file, JSON.stringify({ ...fixtureProduct, date: '2026-02-31T12:00:00Z', traeVersionCode: 20250325 }));
  const configured = { 'x-app-id': 'manual-app' };
  fillTraeDesktopHeaders(configured, options(installDir));
  assert.deepEqual(configured, { 'x-app-id': 'manual-app', 'x-ide-version-code': '20250325' });

  let lookups = 0;
  const locate = () => { lookups++; return { installDir }; };
  fillTraeDesktopHeaders(configured, { ...options(installDir), locate });
  for (const override of [{ base: 'https://custom.example' }, { payBase: 'https://custom.example' }]) {
    const headers = {};
    fillTraeDesktopHeaders(headers, { ...options(installDir), ...override, locate });
    assert.deepEqual(headers, {});
  }
  assert.equal(lookups, 0);
});

test('Trae keeps configured headers when the install is missing or metadata is invalid', (t) => {
  const { file, installDir } = fixture(t);
  const headers = { 'x-ide-version-code': 'manual-version' };
  fillTraeDesktopHeaders(headers, options(installDir));
  for (const content of [
    '{partial',
    JSON.stringify({ bootConfig: { agent: { appId: 'invalid\r\nheader' } }, traeVersionCode: 'invalid' }),
    JSON.stringify({ ...fixtureProduct, padding: ' '.repeat(1024 * 1024) }),
  ]) {
    writeFileSync(file, content);
    fillTraeDesktopHeaders(headers, options(installDir));
  }
  assert.deepEqual(headers, { 'x-ide-version-code': 'manual-version' });
});

test('Trae replaces a non-numeric device id with the registered one used for check-in claims', (t) => {
  const { file, installDir } = fixture(t);
  writeFileSync(file, JSON.stringify(fixtureProduct));
  const discover = { ...options(installDir), readDeviceId: () => '1234567890123456' };

  const stale = { 'x-device-id': 'ef4521dd-1a2b-4c3d-8e9f-000000000000' };
  fillTraeDesktopHeaders(stale, discover);
  assert.equal(stale['x-device-id'], '1234567890123456');

  const registered = { 'x-device-id': '1111222233334444' };
  fillTraeDesktopHeaders(registered, discover);
  assert.equal(registered['x-device-id'], '1111222233334444');

  const unresolved = { 'x-device-id': 'ef4521dd-1a2b-4c3d-8e9f-000000000000' };
  fillTraeDesktopHeaders(unresolved, { ...options(installDir), readDeviceId: () => '' });
  assert.equal(unresolved['x-device-id'], 'ef4521dd-1a2b-4c3d-8e9f-000000000000');
});

test('Trae reads the registered device id from client storage', (t) => {
  const appData = mkdtempSync(join(tmpdir(), 'nicerouter-trae-storage-'));
  const storageDir = join(appData, 'Trae CN', 'User', 'globalStorage');
  const storage = join(storageDir, 'storage.json');
  mkdirSync(storageDir, { recursive: true });
  t.after(() => rmSync(appData, { recursive: true, force: true }));

  writeFileSync(storage, JSON.stringify({
    'iCubeAuthInfo://icube-dc:1234567890123456': { token: 'should-not-import' },
    'other.setting': true,
  }));
  assert.equal(readTraeDeviceId({ env: { APPDATA: appData }, platform: 'win32' }), '1234567890123456');
  assert.equal(readTraeDeviceId({ env: { APPDATA: appData }, platform: 'darwin' }), '');

  writeFileSync(storage, JSON.stringify({ 'iCubeAuthInfo://icube-dc:short': true }));
  assert.equal(readTraeDeviceId({ env: { APPDATA: appData }, platform: 'win32' }), '');

  writeFileSync(storage, '{partial');
  assert.equal(readTraeDeviceId({ env: { APPDATA: appData }, platform: 'win32' }), '');
  assert.equal(readTraeDeviceId({ env: { APPDATA: join(appData, 'missing') }, platform: 'win32' }), '');
});
