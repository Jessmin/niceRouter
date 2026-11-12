import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { desktopInstall } from './desktop-installs.js';

export const TRAE_CHAT_BASE = 'https://api5-normal.mchost.guru';
export const TRAE_PAY_BASE = 'https://api.trae.cn';

const MAX_PRODUCT_BYTES = 1024 * 1024;
const APP_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VERSION_CODE = /^\d{8}$/;
const matchesBase = (base, expected) => base === expected || base === expected + '/';

function buildVersionCode(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(date)) return '';
  const timestamp = Date.parse(date);
  const day = date.slice(0, 10);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(day + 'T')
    ? day.replaceAll('-', '') : '';
}

/** Supply only the missing application metadata needed by the built-in routes. */
export function fillTraeDesktopHeaders(headers, { base, payBase, locate = desktopInstall }) {
  if (!matchesBase(base, TRAE_CHAT_BASE) || !matchesBase(payBase, TRAE_PAY_BASE)) return;
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
