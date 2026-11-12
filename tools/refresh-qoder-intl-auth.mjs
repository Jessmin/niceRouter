import { fileURLToPath } from 'node:url';
import { refreshQoderDesktopSession } from './qoder-desktop-session.mjs';

refreshQoderDesktopSession({
  provider: 'qoder-intl',
  profileName: 'com.qoder.app.stable',
  profileOverride: process.env.QODER_INTL_USER_DATA,
  outputFile: fileURLToPath(new URL('../config/qoder-intl-session.json', import.meta.url)),
  command: 'tools/refresh-qoder-intl-auth.mjs',
});
