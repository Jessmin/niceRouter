import { fileURLToPath } from 'node:url';
import { qoderDesktopProfile } from '../src/qoder-desktop-session.js';
import { refreshQoderDesktopSession } from './qoder-desktop-session.mjs';

refreshQoderDesktopSession({
  provider: 'qoder-intl',
  profile: qoderDesktopProfile('qoder-intl'),
  outputFile: fileURLToPath(new URL('../config/qoder-intl-session.json', import.meta.url)),
  command: 'tools/refresh-qoder-intl-auth.mjs',
});
