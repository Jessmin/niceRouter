import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { normalizeDesktopFolder, readDesktopFolders } from './desktop-folders.js';

const qoderWorker = (pkg) => [
  'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai', pkg, 'dist', '_worker', 'qoder-worker-runtime.obf.mjs',
];

const products = {
  trae: {
    display: /^trae cn(?=\s*\(|\s+\d|$)/i,
    folders: ['Trae CN'], exes: ['Trae CN.exe'],
  },
  qoder: {
    display: /^qoder cn(?=\s*\(|\s+\d|$)/i,
    folders: ['Qoder CN'], exes: ['Qoder CN.exe'],
    exeEnv: 'QODER_EXE', workerEnv: 'QODER_WORKER', worker: qoderWorker('qoder-cn-agent-sdk'),
  },
  'qoder-intl': {
    display: /^qoder(?=\s*\(|\s+\d|$)/i,
    folders: ['Qoder'], exes: ['Qoder.exe'],
    workerEnv: 'QODER_INTL_WORKER', worker: qoderWorker('qoder-agent-sdk'),
  },
  workbuddy: {
    display: /^workbuddy(?: ai)?(?=\s*\(|\s+\d|$)/i,
    folders: ['WorkBuddyAI', 'WorkBuddy', 'WorkBuddy AI'], exes: ['WorkBuddy.exe', 'WorkBuddyAI.exe'],
    installEnv: 'WORKBUDDY_INSTALL_DIR', exeEnv: 'WORKBUDDY_EXE', workerEnv: 'WORKBUDDY_CLI_PATH',
    worker: ['resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'],
    resources: ['resources', 'app.asar'],
  },
  'minimax-code': {
    display: /^minimax code(?=\s*\(|\s+\d|$)/i,
    folders: ['MiniMax Code'], exes: ['MiniMax Code.exe'], installEnv: 'MINIMAX_CODE_INSTALL_DIR',
    resources: ['resources', 'app.asar'],
  },
  doubao: {
    display: /^(?:豆包|doubao)(?=\s*\(|\s+\d|$)/i,
    folders: ['Doubao'], exes: ['Doubao.exe'], installEnv: 'DOUBAO_INSTALL_DIR',
  },
};

const savedFolders = process.platform === 'win32' ? readDesktopFolders() : {};

let uninstallEntries;
function readUninstallEntries() {
  if (uninstallEntries) return uninstallEntries;
  const script = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$paths = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match '^(Trae CN|Qoder|WorkBuddy|MiniMax Code|Doubao|豆包)' } |
  Select-Object DisplayName, InstallLocation, DisplayIcon)
ConvertTo-Json -InputObject $apps -Compress`;
  try {
    const exe = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 3500, maxBuffer: 256 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(output.trim());
    uninstallEntries = Array.isArray(parsed) ? parsed : [];
  } catch {
    uninstallEntries = [];
  }
  return uninstallEntries;
}

function isFile(filename) {
  try { return statSync(filename).isFile(); } catch { return false; }
}

function registryPath(value, env) {
  if (typeof value !== 'string') return '';
  const clean = value.trim().replace(/,\s*-?\d+$/, '').replace(/^"|"$/g, '');
  const expanded = clean.replace(/%([^%]+)%/g, (whole, key) => env[key] || whole);
  // Registry metadata is a path hint. Ignore network shares and device names.
  return /^[A-Za-z]:[\\/]/.test(expanded) ? expanded : '';
}

function doubaoLastBrowser(profile) {
  try {
    const bytes = readFileSync(path.join(profile, 'Last Browser'));
    const exe = bytes.toString(bytes.includes(0) ? 'utf16le' : 'utf8').replace(/\0/g, '').trim();
    return /[\\/]Doubao\.exe$/i.test(exe) ? exe : '';
  } catch { return ''; }
}

function inspectInstall(name, installDir, { file, join, exeOverride, workerOverride }) {
  const spec = products[name];
  const exePath = exeOverride || spec.exes.map((name) => join(installDir, name)).find(file);
  if (!exePath || (exeOverride && !file(exeOverride))) return null;
  const worker = spec.worker && (workerOverride || join(installDir, ...spec.worker));
  const workerPath = worker && file(worker) ? worker : null;
  const runtime = spec.resources && join(installDir, ...spec.resources);
  const complete = (!spec.worker || workerPath)
    && (!runtime || file(runtime) || (name === 'minimax-code' && ['app', 'app.asar.unpacked'].some((folder) =>
      file(join(installDir, 'resources', folder, 'package.json')))));
  return { installation: { installDir, exePath, workerPath }, complete };
}

export function desktopFolderCanOverride(name, env = process.env) {
  if (!Object.hasOwn(products, name)) return false;
  const { installEnv, exeEnv, workerEnv } = products[name];
  if (name === 'qoder-intl' && env.QODER_INTL_EXE && !isFile(env.QODER_INTL_EXE)) return false;
  return ![installEnv, exeEnv, workerEnv].some((key) => key && env[key]);
}

/** Validate a chosen folder without using executable or worker overrides. */
export function desktopInstallInFolder(name, directory, { platform = process.platform, file = isFile } = {}) {
  if (platform !== 'win32' || !Object.hasOwn(products, name)) return null;
  const installDir = normalizeDesktopFolder(directory);
  if (!installDir) return null;
  const { join } = path.win32;
  const candidates = name === 'doubao' ? [installDir, join(installDir, 'app')] : [installDir];
  for (const candidate of candidates) {
    const found = inspectInstall(name, candidate, { file, join });
    if (found?.complete) return found.installation;
  }
  return null;
}

/** Locate a desktop executable and its packaged runtime without launching it. */
export function desktopInstall(name, {
  env = process.env, platform = process.platform, home = homedir(), file = isFile,
  registry = readUninstallEntries, lastBrowser = doubaoLastBrowser, folders = savedFolders,
} = {}) {
  if (!Object.hasOwn(products, name)) return null;
  const spec = products[name];
  const paths = platform === 'win32' ? path.win32 : path;
  const { join, dirname, normalize } = paths;
  const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const installOverride = spec.installEnv && env[spec.installEnv];
  const exeOverride = spec.exeEnv && env[spec.exeEnv];
  const workerOverride = spec.workerEnv && env[spec.workerEnv];
  const roots = [join(local, 'Programs'), local, env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432];
  const tried = new Set();
  let found = null;
  function inspect(directory) {
    if (!directory) return null;
    const installDir = normalize(directory);
    const key = platform === 'win32' ? installDir.toLowerCase() : installDir;
    if (tried.has(key)) return null;
    tried.add(key);
    const result = inspectInstall(name, installDir, { file, join, exeOverride, workerOverride });
    if (!result) return null;
    found ??= result.installation;
    return result.complete ? result.installation : null;
  }

  if (installOverride || exeOverride) return inspect(installOverride || dirname(exeOverride)) || found;
  const saved = desktopInstallInFolder(name, folders[name], { file, platform });
  if (saved) return workerOverride ? inspect(saved.installDir) || found : saved;
  if (name === 'doubao') {
    const exe = lastBrowser(env.DOUBAO_USER_DATA || join(local, 'Doubao', 'User Data'));
    if (exe) {
      const discovered = inspect(dirname(exe));
      if (discovered) return discovered;
    }
  }
  for (const root of roots.filter(Boolean)) {
    for (const folder of spec.folders) {
      const dir = join(root, folder);
      const discovered = inspect(dir) || (name === 'doubao' ? inspect(join(dir, 'app')) : null);
      if (discovered) return discovered;
    }
  }
  if (platform !== 'win32') return found;
  for (const entry of registry()) {
    if (!spec.display.test(entry?.DisplayName?.trim?.() || '')) continue;
    const location = registryPath(entry.InstallLocation, env);
    const icon = registryPath(entry.DisplayIcon, env);
    for (const dir of [location, icon && dirname(icon)].filter(Boolean)) {
      const discovered = inspect(dir) || inspect(join(dir, 'app'));
      if (discovered) return discovered;
    }
  }
  return found;
}
