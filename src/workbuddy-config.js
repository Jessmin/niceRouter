import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopInstall } from './desktop-installs.js';
import { buildWorkbuddyCatalog, resolveWorkbuddyProduct } from './workbuddy-models.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const installed = desktopInstall('workbuddy');
const installDir = process.env.WORKBUDDY_INSTALL_DIR || installed?.installDir
  || join(process.env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Programs/WorkBuddyAI');
const configDir = process.env.WORKBUDDY_CONFIG_DIR || join(homedir(), '.workbuddy');
const modelFiles = new Map();
function readModelFile(file) {
  try {
    const stat = statSync(file, { throwIfNoEntry: false });
    if (stat?.isFile()) {
      const revision = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      const prior = modelFiles.get(file);
      if (prior?.revision === revision) return prior;
      const loaded = { revision, modified: stat.mtimeMs, value: JSON.parse(readFileSync(file, 'utf8')) };
      modelFiles.set(file, loaded);
      return loaded;
    }
  } catch { /* A missing, unreadable or partially replaced catalogue is optional. */ }
  modelFiles.delete(file);
  return null;
}
function product(file) {
  const data = readModelFile(file)?.value;
  return Array.isArray(data?.models) && data.models.length ? data : null;
}
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
      && [this.exePath, this.cliPath, join(this.installDir, 'resources', 'app.asar'), this.authFile].every(existsSync);
  },
  cachedProduct() { return product(this.productFile); },
  packagedProduct() { return product(join(dirname(this.cliPath), '..', 'product.json')); },
  models(cachedProduct = this.cachedProduct()) {
    const snapshot = readModelFile(this.modelsFile)?.value;
    const snapshotModels = Array.isArray(snapshot?.models) ? snapshot.models : [];
    if (cachedProduct) {
      // Keep the existing manual catalogue refresh effective for a newer snapshot.
      const cacheModified = modelFiles.get(this.productFile)?.modified || 0;
      const preferSnapshot = !process.env.WORKBUDDY_PRODUCT_CONFIG && snapshotModels.length && Date.parse(snapshot.refreshedAt) > cacheModified;
      if (!preferSnapshot) {
        const models = buildWorkbuddyCatalog(resolveWorkbuddyProduct(this.packagedProduct(), cachedProduct)).models;
        if (models.length) return models;
      }
    }
    if (snapshotModels.length) return snapshotModels.map((model) => ({ ...model }));
    return buildWorkbuddyCatalog(this.packagedProduct()).models;
  },
};
