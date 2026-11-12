import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopInstall } from './desktop-installs.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installed = desktopInstall('workbuddy');
const installDir = process.env.WORKBUDDY_INSTALL_DIR || installed?.installDir
  || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Programs/WorkBuddyAI');
const configDir = process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
function json(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
export const workbuddyConfig = {
  installDir,
  configDir,
  exePath: process.env.WORKBUDDY_EXE || installed?.exePath || join(installDir, 'WorkBuddy.exe'),
  cliPath: process.env.WORKBUDDY_CLI_PATH || installed?.workerPath || join(installDir, 'resources/app.asar.unpacked/cli/bin/codebuddy'),
  authFile: process.env.WORKBUDDY_AUTH_FILE || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info'),
  productFile: process.env.WORKBUDDY_PRODUCT_CONFIG || join(configDir, 'cache/acc-product-config-v3.json'),
  wrapperPath: join(root, 'tools/workbuddy-cli.cjs'),
  cwd: process.env.WORKBUDDY_CWD || join(root, 'tools/workbuddy-sandbox'),
  timeoutMs: Number(process.env.WORKBUDDY_TIMEOUT_MS) || 600000,
  modelsFile: join(root, 'config/models.workbuddy.json'),
  enabled() {
    return process.env.WORKBUDDY_ENABLED !== '0'
      && [this.exePath, this.cliPath, join(this.installDir, 'resources', 'app.asar'), this.authFile, this.productFile].every(existsSync);
  },
  models() { return (json(this.modelsFile)?.models || []).map((m) => ({ ...m })); },
};
