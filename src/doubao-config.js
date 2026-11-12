import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDoubaoProfileDir, doubaoAuthFile } from './doubao-auth.js';
import { desktopInstall } from './desktop-installs.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = process.env.DOUBAO_USER_DATA || defaultDoubaoProfileDir();

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function installedVersion() {
  const directory = process.env.DOUBAO_INSTALL_DIR || desktopInstall('doubao')?.installDir;
  return directory && readJson(join(directory, 'manifest.json'))?.version || '2.34.6';
}

const timeout = Number(process.env.DOUBAO_TIMEOUT_MS || 180000);
export const doubaoConfig = {
  rootDir: ROOT,
  profileDir,
  authFile: doubaoAuthFile({ rootDir: ROOT }),
  enabled: process.env.DOUBAO_ENABLED !== '0',
  clientVersion: process.env.DOUBAO_PC_VERSION || installedVersion(),
  timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 180000,
  modelsFile: join(ROOT, 'config', 'models.doubao.json'),
};

export function doubaoRequestParams(cfg = doubaoConfig) {
  const deviceId = readJson(join(cfg.profileDir, 'Local State'))?.aha?.device?.device_id;
  return {
    aid: '582478', real_aid: '582478', version_code: '20800', language: 'zh',
    ...(typeof deviceId === 'string' && deviceId ? { device_id: deviceId } : {}),
    device_platform: 'web', doubao_device_platform: 'desktop', client_platform: 'pc_client',
    pkg_type: 'release_version', web_platform: 'desktop', region: 'CN', sys_region: 'CN',
    runtime: 'web', runtime_version: '3.44.2', channel: 'win',
    ...(typeof deviceId === 'string' && deviceId ? { tea_uuid: deviceId, fp: `verify_${deviceId}` } : {}),
    pc_version: cfg.clientVersion, doubao_pc_version: cfg.clientVersion,
    samantha_web: '1', 'use-olympus-account': '1',
  };
}

export function readDoubaoModels(cfg = doubaoConfig) {
  const models = readJson(cfg.modelsFile)?.models;
  return Array.isArray(models) ? models.filter((model) => typeof model?.id === 'string'
    && typeof model.modelItemKey === 'string' && model.conversationMode === 'chat') : [];
}
