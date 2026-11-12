import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pickDesktopFolder, readDesktopFolders, saveDesktopFolder } from '../src/desktop-folders.js';

test('folder choices update only the selected provider and survive reload', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'nicerouter-desktop-folders-'));
  const file = join(directory, 'desktop-folders.json');
  t.after(() => {
    unlinkSync(file);
    rmdirSync(directory);
  });
  const options = { file };
  assert.deepEqual(Object.keys(readDesktopFolders(options)), []);
  assert.equal(saveDesktopFolder('workbuddy', 'E:/应用/WorkBuddy', options), true);
  assert.equal(saveDesktopFolder('qoder-intl', 'D:\\Qoder', options), true);
  assert.equal(saveDesktopFolder('workbuddy', 'E:\\应用\\WorkBuddy', options), false);
  assert.equal(saveDesktopFolder('workbuddy', 'E:\\Other\\WorkBuddy', options), true);
  const expected = { workbuddy: 'E:\\Other\\WorkBuddy', 'qoder-intl': 'D:\\Qoder' };
  assert.deepEqual({ ...readDesktopFolders(options) }, expected);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), expected);
  assert.deepEqual(readdirSync(directory), ['desktop-folders.json']);

  for (const path of ['relative', '\\App', '\\\\server\\share', '\\\\?\\E:\\App', 'E:\\App:stream']) {
    assert.throws(() => saveDesktopFolder('workbuddy', path, options), TypeError);
  }
  assert.throws(() => saveDesktopFolder('__proto__', 'E:\\App', options), TypeError);
  assert.deepEqual({ ...readDesktopFolders(options) }, expected);

  writeFileSync(file, '{"qoder":"relative","trae":"E:/Trae CN","__proto__":"E:/Unused"}');
  assert.deepEqual({ ...readDesktopFolders(options) }, { trae: 'E:\\Trae CN' });
  writeFileSync(file, '{');
  assert.deepEqual(Object.keys(readDesktopFolders(options)), []);
  writeFileSync(file, Buffer.alloc(128 * 1024 + 1));
  assert.deepEqual(Object.keys(readDesktopFolders(options)), []);
});

test('the Windows picker uses the system executable and preserves Unicode paths', async () => {
  const { signal } = new AbortController();
  const directory = await pickDesktopFolder({ provider: 'doubao', signal }, {
    platform: 'win32',
    run: async (executable, args, options) => {
      assert.match(executable, /^[a-z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
      assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-STA', '-Command']);
      assert.match(args[4], /\$dialog\.ShowDialog\(\$owner\)/);
      assert.equal(options.env.NICEROUTER_FOLDER_CLIENT, '豆包');
      assert.equal(options.signal, signal);
      return { stdout: 'E:\\应用\\Doubao' };
    },
  });
  assert.equal(directory, 'E:\\应用\\Doubao');
});

test('one picker can be open, cancellation releases it, and other hosts cannot open it', async () => {
  let closePicker;
  const pending = pickDesktopFolder({ provider: 'trae' }, {
    platform: 'win32', run: () => new Promise((resolve) => { closePicker = resolve; }),
  });
  const neverRun = () => { assert.fail('must not launch another picker'); };
  await assert.rejects(pickDesktopFolder({ provider: 'qoder' }, { platform: 'win32', run: neverRun }), { status: 409 });
  await assert.rejects(pickDesktopFolder({ provider: 'trae' }, { platform: 'linux', run: neverRun }), { status: 400 });
  closePicker({ stdout: '' });
  assert.equal(await pending, null);
  assert.equal(await pickDesktopFolder({ provider: 'trae' }, {
    platform: 'win32', run: async () => ({ stdout: 'D:\\Trae CN' }),
  }), 'D:\\Trae CN');
});

test('an aborted picker returns no path and allows a later request', async () => {
  const controller = new AbortController();
  await assert.rejects(pickDesktopFolder({ provider: 'trae', signal: controller.signal }, {
    platform: 'win32',
    run: async () => {
      controller.abort();
      return { stdout: 'D:\\Trae CN' };
    },
  }), { name: 'AbortError' });
  await assert.rejects(pickDesktopFolder({ provider: 'trae' }, {
    platform: 'win32', run: async () => ({ stdout: '\\\\server\\App' }),
  }), { status: 400 });
  assert.equal(await pickDesktopFolder({ provider: 'trae' }, {
    platform: 'win32', run: async () => ({ stdout: '' }),
  }), null);
});
