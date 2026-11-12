import { fileURLToPath } from 'node:url';
import { qoderDesktopProfile } from '../src/qoder-desktop-session.js';
import { refreshQoderDesktopSession } from './qoder-desktop-session.mjs';

refreshQoderDesktopSession({
  provider: 'qoder-cn',
  profile: qoderDesktopProfile('qoder'),
  outputFile: fileURLToPath(new URL('../config/qoder-session.json', import.meta.url)),
  command: 'tools/refresh-qoder-auth.mjs',
});
