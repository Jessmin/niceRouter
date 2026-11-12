import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { desktopInstall } from './desktop-installs.js';
import { doubaoConfig } from './doubao-config.js';
import { minimaxCodeConfig, readMiniMaxCodeDesktopVersion } from './minimax-code-auth.js';
import { workbuddyConfig } from './workbuddy-config.js';

const found = (name) => Boolean(desktopInstall(name));

export function desktopClientStatuses(enabledNames, qoderDesktopAuthAllowed = true) {
  const available = new Set(enabledNames);
  const row = (name, installed, issue, { disabled = false, channels = [name] } = {}) => {
    const providers = channels.filter((channel) => available.has(channel));
    if (disabled) return { name, installed, providers, state: 'disabled', message: '此通道已在网关配置中关闭。' };
    if (issue && (installed || providers.length)) {
      return { name, installed, providers, state: 'setup_required', message: issue };
    }
    if (providers.length) return { name, installed, providers, state: 'enabled', message: '已加入转发模型列表。' };
    return { name, installed, providers, state: 'not_detected', message: '未找到可识别的客户端。若已安装，请检查安装目录和本机账号配置。' };
  };

  const qoderExe = existsSync(config.qoder.exePath);
  const qoderWorker = existsSync(config.qoder.workerPath);
  const intlWorker = existsSync(config.qoderIntl.workerPath);
  const qoderAuthIssue = !qoderDesktopAuthAllowed
    ? '局域网监听需设置 GATEWAY_KEY 后才会自动读取桌面授权。'
    : process.env.AUTO_DISCOVER_DESKTOP_AUTH === '0' ? '桌面授权自动读取已关闭，详见 README。' : '';
  const buddy = workbuddyConfig;
  const buddyExe = existsSync(buddy.exePath);
  const buddyIssue = !buddyExe || !existsSync(buddy.cliPath) || !existsSync(join(buddy.installDir, 'resources', 'app.asar'))
    ? '找不到官方 CLI。检查 WorkBuddy 安装位置和 WORKBUDDY_INSTALL_DIR。'
    : !existsSync(buddy.authFile)
      ? '请用当前 Windows 用户登录 WorkBuddy，再刷新。'
      : available.has('workbuddy') ? '' : '未加载到 WorkBuddy 模型目录。';

  let miniMaxIssue = '';
  if (!minimaxCodeConfig.region) miniMaxIssue = '检查 MINIMAX_CODE_REGION，使用 cn 或 global。';
  else if (!available.has('minimax-code')) miniMaxIssue = '打开同地区的 MiniMax Code 客户端并登录。';
  else if (!readMiniMaxCodeDesktopVersion()) {
    miniMaxIssue = '已加入模型列表。额度与签到需要客户端版本，请检查 MINIMAX_CODE_INSTALL_DIR 后重启。';
  }

  return [
    row('trae', found('trae'), config.trae.token ? '' : 'Trae IDE 和 SOLO 需要配置转发接口的 Cloud-IDE-JWT，详见 README。', { channels: ['trae', 'solo'] }),
    row('qoder', qoderExe || found('qoder'), !qoderExe || !qoderWorker
      ? '检查 Qoder CN 安装位置及 QODER_EXE、QODER_WORKER。'
      : !config.qoder.token ? qoderAuthIssue || '已接入转发。额度和签到尚未读取到本机授权，请登录 Qoder CN 后重启网关。' : ''),
    row('qoder-intl', intlWorker || found('qoder-intl'), !intlWorker || !existsSync(config.qoderIntl.exePath)
      ? '检查 Qoder 国际版安装位置及 QODER_INTL_WORKER。'
      : !config.qoderIntl.token ? qoderAuthIssue || '尚未读取到本机授权，请登录 Qoder 国际版后重启网关。'
        : available.has('qoder-intl') ? '' : '未加载到 Qoder 国际版模型目录。'),
    row('workbuddy', buddyExe || found('workbuddy'), buddyIssue, { disabled: process.env.WORKBUDDY_ENABLED === '0' }),
    row('minimax-code', found('minimax-code'), miniMaxIssue, { disabled: !minimaxCodeConfig.enabled }),
    row('doubao', found('doubao'), available.has('doubao') ? ''
      : '登录豆包桌面端并退出，再运行 tools/refresh-doubao-auth.mjs 后重启网关。', { disabled: !doubaoConfig.enabled }),
  ];
}
