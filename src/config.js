import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_PROGRAMS = join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Programs');
const QODER_CN_INSTALL = join(LOCAL_PROGRAMS, 'Qoder CN');
const QODER_CN_UMID = process.env.QODER_UMID || join(homedir(), '.qoder-cn', 'umid-cache.json');

function readJson(relPath) {
  return JSON.parse(readFileSync(join(ROOT, relPath), 'utf8'));
}

function tryReadJson(relPath) {
  try {
    return readJson(relPath);
  } catch {
    return null;
  }
}

/** 读 Qoder 的 umid 机器指纹缓存（绝对路径，不相对 ROOT） */
function readUmid(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return j.info || null;
  } catch {
    return null;
  }
}

// 真实抓包固化的会话凭据（token + 全套请求头 + 端点 + intent）
const session = tryReadJson('config/trae-session.json') || {};
const traeHeaders = Object.fromEntries([
  ...Object.entries(session.headers || {}),
  ...Object.entries(JSON.parse(process.env.TRAE_HEADERS || '{}')),
].map(([key, value]) => [key.toLowerCase(), value]));
const stripTraeScheme = (value) => typeof value === 'string' ? value.trim().replace(/^(?:Cloud-IDE-JWT|Bearer)\s+/i, '') : '';
const envTraeToken = stripTraeScheme(process.env.TRAE_TOKEN);
if (envTraeToken) {
  traeHeaders.authorization = `Cloud-IDE-JWT ${envTraeToken}`;
  traeHeaders['x-ide-token'] = envTraeToken;
}

export const config = {
  port: Number(process.env.PORT || 8787),
  // 监听地址：127.0.0.1（仅本机）/ 0.0.0.0（局域网可访问）
  host: process.env.HOST || '127.0.0.1',
  // 留空 = 免密，局域网任何设备直接用；设了则访问方需在网页设置里填同一串
  gatewayKey: process.env.GATEWAY_KEY || '',

  // 未带 provider 前缀的请求默认走 SOLO；各真实通道仍可通过模型前缀独立使用。
  adapter: process.env.ADAPTER || 'solo',

  // ADAPTER=openai 时用：换厂商只要改 base 和 key
  upstream: {
    baseUrl: process.env.UPSTREAM_BASE || '',
    apiKey: process.env.UPSTREAM_KEY || '',
    headers: JSON.parse(process.env.UPSTREAM_HEADERS || '{}'),
  },

  trae: {
    base: process.env.TRAE_BASE || session.base || 'https://api5-normal.mchost.guru',
    // 积分/权益接口在另一个域名（抓包实证，用 base 会 404）
    payBase: process.env.TRAE_PAY_BASE || 'https://api.trae.cn',
    deviceId: process.env.TRAE_DEVICE_ID || session.deviceId || traeHeaders['x-device-id'] || '',
    chatPath: process.env.TRAE_CHAT_PATH || session.chatPath || '/api/ide/v1/chat',
    modelListPath: session.modelListPath || '/api/ide/v1/model_list?type=chat',
    // 通用问答 intent，缺了它非默认模型会报 "intent not found"
    intent: process.env.TRAE_INTENT || session.intent || 'general_qa_intent',
    token: envTraeToken || stripTraeScheme(traeHeaders.authorization),
    // 真实客户端头（device-id / machine-id / package-type / 版本号等），服务端会校验其中几项
    headers: traeHeaders,
    // Body template, kept as raw text so {{placeholders}} can sit outside quotes.
    payloadTemplate: readFileSync(join(ROOT, 'config/trae-payload.json'), 'utf8'),
    timeoutMs: Number(process.env.TRAE_TIMEOUT_MS || 180000),
    // Dump every upstream request/response pair to ./captures for inspection
    capture: process.env.TRAE_CAPTURE === '1',
  },

  // solo_agent 通道：/api/agent/v3/llm_utils_chat（明文可用，能调 110 个真实模型）
  // 代价是排队，免费档实测要等 2~3 分钟，所以超时给到 10 分钟
  solo: {
    chatPath: process.env.SOLO_CHAT_PATH || '/api/agent/v3/llm_utils_chat',
    // 服务端注册的路由键，写错会返回 2001 no function config found
    function: process.env.SOLO_FUNCTION || 'solo_agent',
    timeoutMs: Number(process.env.SOLO_TIMEOUT_MS || 600000),
  },
  soloModels: (tryReadJson('config/models.solo.json') || {}).models || [],

  // Qoder CN —— 复用官方 CLI（签名在 WASM 里，直连必 403，详见 config/intel-qoder-cn.md）
  qoder: {
    provider: 'qoder',
    cliName: 'qoderclicn',
    // 积分 / 权益 / 活动接口全在 openapi 域名，且都是明文 Bearer（不需要签名）
    openapiBase: process.env.QODER_OPENAPI || 'https://openapi.qoder.com.cn',
    // 关键：/sash/api/v1/me/campaigns 不带这个头会返回空列表（实测二进制搜索得出）
    clientType: Number(process.env.QODER_CLIENT_TYPE || 10),
    clientVersion: process.env.QODER_CLIENT_VERSION || '0.4.8',
    // 机器指纹：CLI 从 umid 缓存里取，缺了活动接口会返回 showCampaign:false
    machineFile: QODER_CN_UMID,
    // Electron 主程序当 node 用
    exePath: process.env.QODER_EXE || join(QODER_CN_INSTALL, 'Qoder CN.exe'),
    // 这个 .obf.mjs 本身就是完整 CLI（qoderclicn）
    workerPath:
      process.env.QODER_WORKER ||
      join(QODER_CN_INSTALL, 'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-cn-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs'),
    cwd: process.env.QODER_CWD || ROOT,
    // 冷启动约 1.5~2s，正常回答 2~10s，给足余量
    timeoutMs: Number(process.env.QODER_TIMEOUT_MS || 300000),
    maxConcurrency: Number(process.env.QODER_MAX_CONCURRENCY || 4),
    // 积分查询用的 access token（由 tools/refresh-qoder-auth.mjs 从 auth.v1.dat 解出后写入）
    token: process.env.QODER_TOKEN || (tryReadJson('config/qoder-session.json') || {}).token || '',
    // 机器指纹（umid 缓存），活动/权益接口按它判定"这台机器能领什么"
    machine: readUmid(QODER_CN_UMID) || {},
  },
  qoderModels: (tryReadJson('config/models.qoder.json') || {}).models || [],

  // International Qoder has its own CLI, account, machine cache and model catalogue.
  qoderIntl: {
    provider: 'qoder-intl',
    cliName: 'qodercli',
    sdkHostToken: true,
    openapiBase: process.env.QODER_INTL_OPENAPI || 'https://openapi.qoder.sh',
    clientType: Number(process.env.QODER_INTL_CLIENT_TYPE || 10),
    clientVersion: process.env.QODER_INTL_CLIENT_VERSION || '0.4.8',
    machineFile: process.env.QODER_INTL_UMID || join(homedir(), '.qoder', 'umid-cache.json'),
    // The international desktop executable is a GUI launcher; Node runs its worker directly.
    exePath: process.env.QODER_INTL_EXE || process.execPath,
    workerPath: process.env.QODER_INTL_WORKER || join(LOCAL_PROGRAMS, 'Qoder', 'resources', 'app.asar.unpacked', 'node_modules', '@qoder-ai', 'qoder-agent-sdk', 'dist', '_worker', 'qoder-worker-runtime.obf.mjs'),
    configDir: process.env.QODER_INTL_CONFIG_DIR || join(homedir(), '.qoder'),
    cwd: process.env.QODER_INTL_CWD || ROOT,
    timeoutMs: Number(process.env.QODER_INTL_TIMEOUT_MS || 300000),
    maxConcurrency: Number(process.env.QODER_INTL_MAX_CONCURRENCY || 4),
    token: process.env.QODER_INTL_TOKEN || (tryReadJson('config/qoder-intl-session.json') || {}).token || '',
    machine: readUmid(process.env.QODER_INTL_UMID || join(homedir(), '.qoder', 'umid-cache.json')) || {},
  },
  qoderIntlModels: (tryReadJson('config/models.qoder-intl.json') || {}).models || [],

  // 换厂商时模型 ID 不一样，用 MODELS_FILE 指向另一份清单即可
  models: readJson(process.env.MODELS_FILE || 'config/models.json').models,
  rootDir: ROOT,
};
