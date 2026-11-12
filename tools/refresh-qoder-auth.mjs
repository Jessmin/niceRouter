import { fileURLToPath } from 'node:url';
import { refreshQoderDesktopSession } from './qoder-desktop-session.mjs';

refreshQoderDesktopSession({
  provider: 'qoder-cn',
  profileName: 'com.qodercn.app.stable',
  profileOverride: process.env.QODER_USER_DATA || process.env.QODER_CN_USER_DATA,
  outputFile: fileURLToPath(new URL('../config/qoder-session.json', import.meta.url)),
  command: 'tools/refresh-qoder-auth.mjs',
});
