import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readQoderDesktopSession } from '../src/qoder-desktop-session.js';

export { readQoderDesktopSession };

export function writeQoderDesktopSession(file, session) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, JSON.stringify(session, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } catch {
    throw new Error('保存 Qoder 网关会话失败，请检查目标目录权限');
  } finally {
    try { unlinkSync(temp); } catch { /* Renamed or never created. */ }
  }
}

export function refreshQoderDesktopSession({ provider, profile: defaultProfile, outputFile, command }) {
  let profile = defaultProfile;
  let output = outputFile;
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log(`用法：node ${command} [--user-data <桌面数据目录>] [--output <会话输出文件>]`);
    return;
  }
  try {
    for (let i = 0; i < args.length; i += 2) {
      const name = args[i], value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error('参数需要指定路径，可用 --help 查看用法');
      if (name === '--user-data') profile = resolve(value);
      else if (name === '--output') output = resolve(value);
      else throw new Error('不支持的参数，可用 --help 查看用法');
    }
    const session = readQoderDesktopSession(profile);
    writeQoderDesktopSession(output, session);
    console.log(JSON.stringify({ provider, saved: true, expiresAt: session.expiresAt || null }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
