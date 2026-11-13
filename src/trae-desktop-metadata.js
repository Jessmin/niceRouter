import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { desktopInstall } from './desktop-installs.js';

export const TRAE_CHAT_BASE = 'https://api5-normal.mchost.guru';
export const TRAE_PAY_BASE = 'https://api.trae.cn';

const MAX_PRODUCT_BYTES = 1024 * 1024;
const APP_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VERSION_CODE = /^\d{8}$/;
// 签到 claim 会按设备号限额：必须是客户端注册过的纯数字号，否则恒返回 9074。
const DEVICE_ID = /^\d{12,20}$/;
const REGISTERED_DEVICE_KEY = /^iCubeAuthInfo:\/\/icube-dc:(\d{12,20})$/;
const matchesBase = (base, expected) => base === expected || base === expected + '/';

/** 客户端把注册设备号写在 storage.json 的键名上，无需解密登录凭据。 */
export function readTraeDeviceId({
  env = process.env, platform = process.platform, home = homedir(),
} = {}) {
  if (platform !== 'win32') return '';
  const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
  const file = join(env.TRAE_USER_DATA || join(roaming, 'Trae CN'), 'User', 'globalStorage', 'storage.json');
  try {
    const storage = JSON.parse(readFileSync(file, 'utf8'));
    if (!storage || typeof storage !== 'object') return '';
    for (const key of Object.keys(storage)) {
      const match = REGISTERED_DEVICE_KEY.exec(key);
      if (match) return match[1];
    }
  } catch {
    // Missing or unreadable client state leaves the configured device id usable.
  }
  return '';
}

function buildVersionCode(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(date)) return '';
  const timestamp = Date.parse(date);
  const day = date.slice(0, 10);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(day + 'T')
    ? day.replaceAll('-', '') : '';
}

/** Supply only the missing application metadata needed by the built-in routes. */
export function fillTraeDesktopHeaders(headers, {
  base, payBase, locate = desktopInstall, readDeviceId = readTraeDeviceId,
}) {
  if (!matchesBase(base, TRAE_CHAT_BASE) || !matchesBase(payBase, TRAE_PAY_BASE)) return;
  if (!DEVICE_ID.test(String(headers['x-device-id'] ?? ''))) {
    const deviceId = readDeviceId();
    if (deviceId) headers['x-device-id'] = deviceId;
  }
  const missingAppId = !Object.hasOwn(headers, 'x-app-id');
  const missingVersion = !Object.hasOwn(headers, 'x-ide-version-code');
  if (!missingAppId && !missingVersion) return;

  let file;
  try {
    const directory = locate('trae')?.installDir;
    if (!directory) return;
    file = openSync(join(directory, 'resources', 'app', 'product.json'), 'r');
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size < 2 || stat.size > MAX_PRODUCT_BYTES) return;
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== stat.size) return;
    const product = JSON.parse(buffer.toString('utf8', 0, length).replace(/^\uFEFF/, ''));
    const appId = product?.bootConfig?.agent?.appId;
    const code = buildVersionCode(product?.date) || product?.traeVersionCode;
    if (missingAppId && typeof appId === 'string' && APP_ID.test(appId)) headers['x-app-id'] = appId;
    if (missingVersion && (typeof code === 'string' || Number.isSafeInteger(code)) && VERSION_CODE.test(String(code))) {
      headers['x-ide-version-code'] = String(code);
    }
  } catch {
    // An unavailable or incomplete install leaves the configured headers usable.
  } finally {
    if (file !== undefined) closeSync(file);
  }
}
