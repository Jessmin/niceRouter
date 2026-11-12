import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const folderFile = fileURLToPath(new URL('../config/desktop-folders.json', import.meta.url));
const maxFileBytes = 128 * 1024;
const clientNames = {
  trae: 'Trae CN',
  qoder: 'Qoder CN',
  'qoder-intl': 'Qoder 国际版',
  workbuddy: 'WorkBuddy',
  'minimax-code': 'MiniMax Code',
  doubao: '豆包',
};

export function isDesktopFolderProvider(provider) {
  return typeof provider === 'string' && Object.hasOwn(clientNames, provider);
}

export function normalizeDesktopFolder(directory) {
  if (typeof directory !== 'string' || directory.length > 4096 || !/^[a-z]:[\\/]/i.test(directory)
      || /[<>:"|?*\u0000-\u001f\u007f]/u.test(directory.slice(2))) return null;
  return win32.normalize(directory);
}

export function readDesktopFolders({ file = folderFile } = {}) {
  const folders = Object.create(null);
  let descriptor;
  try {
    descriptor = openSync(file, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxFileBytes) return folders;
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > stat.size) return folders;
    const data = JSON.parse(buffer.toString('utf8', 0, length));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return folders;
    for (const provider of Object.keys(clientNames)) {
      const directory = Object.hasOwn(data, provider) && normalizeDesktopFolder(data[provider]);
      if (directory) folders[provider] = directory;
    }
  } catch { /* Missing, damaged or inaccessible local configuration. */ }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  return folders;
}

export function saveDesktopFolder(provider, directory, { file = folderFile } = {}) {
  const normalized = normalizeDesktopFolder(directory);
  if (!isDesktopFolderProvider(provider) || !normalized) throw new TypeError('安装目录必须是本地 Windows 文件夹。');
  const folders = readDesktopFolders({ file });
  if (folders[provider] === normalized) return false;
  folders[provider] = normalized;
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify(folders, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* Already renamed or never created. */ }
  }
  return true;
}

// Own the modal dialog with a topmost form so it is visible over the browser.
const folderDialogScript = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$dialog = [Windows.Forms.FolderBrowserDialog]::new()
$owner = [Windows.Forms.Form]::new()
try {
  $dialog.Description = '请选择 ' + $env:NICEROUTER_FOLDER_CLIENT + ' 的安装文件夹'
  $dialog.ShowNewFolderButton = $false
  $owner.FormBorderStyle = [Windows.Forms.FormBorderStyle]::None
  $owner.StartPosition = [Windows.Forms.FormStartPosition]::CenterScreen
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0
  $owner.Show()
  if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) {
    [Console]::Write($dialog.SelectedPath)
  }
} finally {
  $dialog.Dispose()
  $owner.Dispose()
}`;

const execFileAsync = promisify(execFile);
let pickingFolder = false;

export async function pickDesktopFolder({ provider, signal }, { platform = process.platform, run = execFileAsync } = {}) {
  if (!isDesktopFolderProvider(provider)) throw new TypeError('未知的桌面客户端。');
  if (platform !== 'win32') throw Object.assign(new Error('目录选择仅支持本机 Windows。'), { status: 400 });
  signal?.throwIfAborted();
  if (pickingFolder) throw Object.assign(new Error('请先关闭已经打开的文件夹选择窗口。'), { status: 409 });
  pickingFolder = true;
  try {
    const windowsDir = normalizeDesktopFolder(process.env.SystemRoot) || 'C:\\Windows';
    const powershell = win32.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let stdout;
    try {
      ({ stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-Command', folderDialogScript], {
        env: { ...process.env, NICEROUTER_FOLDER_CLIENT: clientNames[provider] },
        encoding: 'utf8', windowsHide: true, timeout: 5 * 60_000, maxBuffer: 32 * 1024, signal,
      }));
    } catch {
      signal?.throwIfAborted();
      throw new Error('无法打开 Windows 文件夹选择窗口。');
    }
    signal?.throwIfAborted();
    const output = stdout.trim();
    if (!output) return null;
    const directory = normalizeDesktopFolder(output);
    if (!directory) throw Object.assign(new Error('请选择本机磁盘上的客户端安装文件夹。'), { status: 400 });
    return directory;
  } finally {
    pickingFolder = false;
  }
}
