import { refreshDoubaoAuth } from '../src/doubao-auth.js';

const options = {};
const flags = new Map([['--cookies', 'cookiesFile'], ['--user-data', 'profileDir'], ['--output', 'outputFile']]);
try {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help' || args[index] === '-h') {
      console.log('node tools/refresh-doubao-auth.mjs [--cookies <snapshot>] [--user-data <profile>] [--output <encryptedfile>]');
      process.exit(0);
    }
    const name = flags.get(args[index]);
    if (!name || !args[index + 1] || args[index + 1].startsWith('--') || Object.hasOwn(options, name)) {
      throw new Error('参数无效，运行 --help 查看用法');
    }
    options[name] = args[++index];
  }
  const result = await refreshDoubaoAuth(options);
  console.log(JSON.stringify({ ok: true, file: result.file, cookies: result.cookieCount, expiresAt: result.expiresAt }));
} catch (error) {
  console.error(error?.code?.startsWith('doubao_auth_') ? error.message : '豆包授权刷新失败，请检查参数、官方登录和可读的 Cookies 快照');
  process.exitCode = 1;
}
