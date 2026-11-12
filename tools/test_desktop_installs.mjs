import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { desktopInstall } from '../src/desktop-installs.js';
import { readMiniMaxCodeDesktopVersion } from '../src/minimax-code-auth.js';

const env = { LOCALAPPDATA: 'C:\\Fixture\\Local', ProgramFiles: 'C:\\Program Files' };
const qoderWorker = (directory, name) => path.win32.join(directory, 'resources/app.asar.unpacked/node_modules/@qoder-ai',
  name, 'dist/_worker/qoder-worker-runtime.obf.mjs');
const workbuddyWorker = (directory) => path.win32.join(directory, 'resources/app.asar.unpacked/cli/bin/codebuddy');

function fixture(files, entries = [], overrides = {}) {
  const normal = (filename) => path.win32.normalize(filename).toLowerCase();
  const known = new Set(files.map(normal));
  return { platform: 'win32', env, home: 'C:\\Fixture', registry: () => entries, lastBrowser: () => '',
    file: (filename) => known.has(normal(filename)), ...overrides };
}

test('use a verified default desktop install before querying the registry', () => {
  const dir = 'C:\\Fixture\\Local\\Programs\\Qoder CN';
  const workerPath = qoderWorker(dir, 'qoder-cn-agent-sdk');
  const exePath = `${dir}\\Qoder CN.exe`;
  assert.deepEqual(desktopInstall('qoder', fixture([exePath, workerPath], [], {
    registry() { throw new Error('registry scan is unnecessary'); },
  })), { installDir: dir, exePath, workerPath });
});

test('find system-wide installs', () => {
  const dir = 'C:\\Program Files\\Trae CN';
  assert.equal(desktopInstall('trae', fixture([`${dir}\\Trae CN.exe`])).installDir, dir);
});

test('prefer an intact package and separate Qoder CN from the international client', () => {
  const cn = 'D:\\Applications\\CN Qoder';
  const intl = 'D:\\Applications\\Global Qoder';
  const files = ['C:\\Fixture\\Local\\Programs\\Qoder CN\\Qoder CN.exe', `${cn}\\Qoder CN.exe`,
    `${intl}\\Qoder.exe`, qoderWorker(cn, 'qoder-cn-agent-sdk'), qoderWorker(intl, 'qoder-agent-sdk')];
  const entries = [{ DisplayName: 'Qoder 1.2.3', InstallLocation: intl },
    { DisplayName: 'Qoder CN 1.2.3', InstallLocation: 'D:\\Deleted', DisplayIcon: `"${cn}\\uninstallerIcon.ico",0` }];
  assert.equal(desktopInstall('qoder', fixture(files, entries)).installDir, cn);
  assert.equal(desktopInstall('qoder-intl', fixture(files, entries)).installDir, intl);
  assert.equal(desktopInstall('qoder-intl', fixture(files, [entries[1]])), null);
});

test('return installed status when the desktop exists without its packaged worker', () => {
  const dir = 'C:\\Program Files\\WorkBuddy';
  assert.deepEqual(desktopInstall('workbuddy', fixture([`${dir}\\WorkBuddy.exe`])), {
    installDir: dir, exePath: `${dir}\\WorkBuddy.exe`, workerPath: null,
  });
});

test('resolve WorkBuddyAI through a validated icon path and honor explicit settings', () => {
  const dir = 'D:\\Portable Apps\\WorkBuddy';
  const stale = 'C:\\Fixture\\Local\\Programs\\WorkBuddyAI';
  const exe = `${dir}\\WorkBuddyAI.exe`;
  const worker = workbuddyWorker(dir);
  const files = [exe, worker, `${dir}\\resources\\app.asar`, `${stale}\\WorkBuddy.exe`, workbuddyWorker(stale)];
  const entries = [{ DisplayName: 'WorkBuddy AI 5.6.2', DisplayIcon: `${exe},0` }];
  assert.deepEqual(desktopInstall('workbuddy', fixture(files, entries)), {
    installDir: dir, exePath: exe, workerPath: worker,
  });
  assert.equal(desktopInstall('workbuddy', fixture([exe, worker], entries, {
    env: { ...env, WORKBUDDY_INSTALL_DIR: 'E:\\Explicit Override' },
  })), null);
  assert.equal(desktopInstall('workbuddy', fixture([exe, worker], entries, {
    env: { ...env, WORKBUDDY_EXE: exe, WORKBUDDY_CLI_PATH: 'E:\\Explicit Worker' },
  })).workerPath, null);
});

test('resolve the Doubao store layout and Last Browser path only when the executable exists', () => {
  const dir = 'D:\\Store\\Doubao\\app';
  const exe = `${dir}\\Doubao.exe`;
  const entries = [{ DisplayName: '豆包', DisplayIcon: '"D:\\Store\\Doubao\\icon.ico"' }];
  assert.equal(desktopInstall('doubao', fixture([exe], entries, { lastBrowser: () => 'E:\\Deleted\\Doubao.exe' })).installDir, dir);
  assert.equal(desktopInstall('doubao', fixture([exe], [], { lastBrowser: () => exe })).installDir, dir);
  assert.equal(desktopInstall('doubao', fixture([], entries, { lastBrowser: () => exe })), null);
});

test('ignore network registry paths and select the MiniMax directory with packaged version metadata', () => {
  const stale = 'C:\\Fixture\\Local\\Programs\\MiniMax Code';
  const dir = 'D:\\Store\\MiniMax Code';
  const entries = [{ DisplayName: 'MiniMax Code 3.2.0', InstallLocation: '\\\\share\\MiniMax Code' },
    { DisplayName: 'MiniMax Code 3.2.0', DisplayIcon: '"%STORE%\\MiniMax Code\\uninstallerIcon.ico",0' }];
  const deps = fixture([`${stale}\\MiniMax Code.exe`, `${dir}\\MiniMax Code.exe`, `${dir}\\resources\\app.asar`], entries, {
    env: { ...env, STORE: 'D:\\Store' },
  });
  const isFile = deps.file;
  deps.file = (filename) => {
    assert.doesNotMatch(filename, /^\\\\share/i);
    return isFile(filename);
  };
  assert.equal(desktopInstall('minimax-code', deps).installDir, dir);
});

test('read the official version from packed or verified unpacked app metadata', async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'nicerouter-install-')));
  assert.equal(path.dirname(temp), await realpath(tmpdir()));
  try {
    const resources = path.join(temp, 'resources');
    const manifest = path.join(resources, 'app.asar.unpacked', 'package.json');
    await mkdir(path.dirname(manifest), { recursive: true });
    await writeFile(manifest, JSON.stringify({ name: '@mmx-agent/electron', version: '3.1.6' }));
    assert.equal(readMiniMaxCodeDesktopVersion(temp), null);
    await writeFile(path.join(temp, 'MiniMax Code.exe'), 'fixture');
    assert.equal(readMiniMaxCodeDesktopVersion(temp), '3.1.6');

    const body = Buffer.from(JSON.stringify({ name: '@mmx-agent/electron', version: '3.2.0' }));
    const header = Buffer.from(JSON.stringify({ files: { 'package.json': { size: body.length, offset: '0' } } }));
    const prefix = Buffer.alloc(16);
    prefix.writeUInt32LE(header.length + 8, 4);
    prefix.writeUInt32LE(header.length, 12);
    await writeFile(path.join(resources, 'app.asar'), Buffer.concat([prefix, header, body]));
    assert.equal(readMiniMaxCodeDesktopVersion(temp), '3.2.0');
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5 });
  }
});
