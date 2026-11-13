/** Installed WorkBuddy.exe + ELECTRON_RUN_AS_NODE=1. Read credentials through
 * the shipped native reader/crypto implementation, then use the official CLI's
 * CODEBUDDY_AUTH_TOKEN input. No package patch or plaintext credential file.
 */
const fs = require('node:fs');
const path = require('node:path');
const ACCOUNT_ENDPOINTS = Object.freeze({
  summary: '/billing/meter/get-user-resource-summary',
  // Desktop client moved check-in to /v2; the legacy /billing/meter/checkin-status
  // now answers code 0 with active:false and no activity, so it can never claim.
  checkin: '/v2/billing/meter/checkin-activity-status',
  claim: '/v2/billing/meter/daily-checkin',
  catalog: '/v3/config',
});

function authCompatibilityError(installDir, load, category) {
  let version;
  try { version = load(path.join(installDir, 'resources/app.asar/package.json'))?.version; }
  catch { /* The installed package may not expose version metadata. */ }
  const release = typeof version === 'string' && version.length <= 48
    && /^\d+\.\d+\.\d+(?:[.-][A-Za-z0-9]+)*(?:\+[A-Za-z0-9.-]+)?$/.test(version) ? ` ${version}` : '（版本未知）';
  return new Error(`WorkBuddy${release} 的加密登录读取尚不兼容（${category}）。`);
}

// Each initializer belongs to a verified package layout. Check the semantic
// function names before invoking it, because bundled aliases can change.
function workbuddyCrypto(installDir, load) {
  const layouts = [
    ['app-lifetime-job.js', 'D', 'G', 'K', 'R'],
    ['process-cpu-sampler.js', 'init_dist', 'normalizeAtRestBuildKeyCapabilities', 'parseSupportedEnvelope', 'AtRestCrypto'],
    ['dist.js', 's', 'T', 'E', 'v'],
    ['dist.js', null, 'normalizeAtRestKeyPayload', 'parseSupportedEnvelope', 'AtRestCrypto'],
  ];
  for (const [file, initialize, normalize, parse, crypto] of layouts) {
    try {
      const api = load(path.join(installDir, 'resources/app.asar/main', file));
      const legacy = normalize === 'normalizeAtRestKeyPayload';
      if (api?.[normalize]?.name !== (legacy ? 'normalizeAtRestKeyPayload' : 'normalizeAtRestBuildKeyCapabilities')
        || api[parse]?.name !== 'parseSupportedEnvelope') continue;
      if (initialize) {
        if (typeof api[initialize] !== 'function') continue;
        api[initialize]();
      }
      const Codec = api[crypto];
      if (Codec?.name === 'AtRestCrypto' && typeof Codec.prototype?.open === 'function' && typeof Codec.prototype.dispose === 'function') {
        return { normalizeKey: api[normalize], parseEnvelope: api[parse], Codec, legacy };
      }
    } catch { /* An absent or incompatible module can belong to another supported layout. */ }
  }
  throw authCompatibilityError(installDir, load, 'credential-runtime-layout');
}

function readWorkbuddySession(installDir, authFile, {
  load = require,
  readFile = fs.readFileSync,
  exists = fs.existsSync,
  readNativeKey = () => process._linkedBinding('electron_browser_workbuddy_storage').loggerGet(),
} = {}) {
  if (!authFile || exists(authFile + '.logged-out')) throw new Error('请先在本机登录 WorkBuddy。');
  let session;
  try { session = JSON.parse(readFile(authFile, 'utf8')); }
  catch { throw new Error('无法读取 WorkBuddy 登录，请在本机登录 WorkBuddy 后重试。'); }
  const id = session?.account?.uid;
  const userId = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id;
  let token = session?.auth?.accessToken;
  if (typeof userId !== 'string' || !userId.trim() || /[\x00-\x1f\x7f]/.test(userId) || !token) {
    throw new Error('请先在本机登录 WorkBuddy。');
  }
  if (typeof token !== 'string') {
    if (token.$wbEncrypted !== 1 || Object.hasOwn(token, 'scheme') || typeof token.envelope !== 'string') {
      const category = token.$wbEncrypted === 1 && token.scheme === 'asym-v1' ? 'auth-field-asymmetric' : 'auth-field-wrapper';
      throw authCompatibilityError(installDir, load, category);
    }
    const envelope = Buffer.from(token.envelope, 'base64');
    if (!envelope.length || envelope.toString('base64') !== token.envelope) {
      throw new Error('WorkBuddy 登录文件格式无效，请重新登录。');
    }
    const { normalizeKey, parseEnvelope, Codec, legacy } = workbuddyCrypto(installDir, load);
    let key, codec, bytes;
    try {
      const normalized = normalizeKey(readNativeKey());
      key = legacy ? normalized : normalized?.symmetric?.value;
      if ((!legacy && normalized?.symmetric?.status !== 'available') || !Buffer.isBuffer(key?.key)) throw new Error();
      codec = new Codec(key);
      bytes = codec.open(parseEnvelope(envelope), { framing: 'field' });
      token = bytes.toString('utf8');
    } catch {
      throw new Error('无法读取 WorkBuddy 的加密登录，请用运行网关的 Windows 用户重新登录 WorkBuddy。');
    } finally {
      bytes?.fill(0);
      try { codec?.dispose(); } finally { key?.key?.fill(0); }
    }
  }
  if (!token || /[\s\x00-\x1f\x7f]/.test(token) || exists(authFile + '.logged-out')) {
    throw new Error('请先在本机登录 WorkBuddy。');
  }
  return { token, userId };
}

// Fixed account paths mirror main/account.js; catalog mirrors CloudProductProvider.
// Claim always rechecks activity inside this process before sending the write.
async function queryWorkbuddyAccount(operation, { token, userId, catalogHeaders = {}, fetchFn = fetch } = {}) {
  if (!Object.hasOwn(ACCOUNT_ENDPOINTS, operation)) throw new Error('Unsupported WorkBuddy account operation');
  const request = async (endpoint) => {
    const method = endpoint === ACCOUNT_ENDPOINTS.catalog ? 'GET' : 'POST';
    const response = await fetchFn('https://www.workbuddy.cn' + endpoint, {
      method, headers: { authorization: 'Bearer ' + token,
        'x-user-id': userId, 'content-type': 'application/json', 'accept-language': 'zh',
        ...(operation === 'catalog' ? catalogHeaders : {}) },
      ...(method === 'POST' ? { body: '{}' } : {}), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      const detail = operation === 'catalog' ? (await response.text()).replace(/(Bearer\s+)\S+/gi, '$1[redacted]').slice(0, 400) : '';
      throw new Error(`WorkBuddy ${endpoint}: HTTP ${response.status}${detail ? ': ' + detail : ''}`);
    }
    return response.json();
  };
  if (operation === 'claim') {
    const status = await request(ACCOUNT_ENDPOINTS.checkin);
    if (status.code !== 0 || !status.data) throw new Error(`WorkBuddy checkin status unavailable (${status.code ?? 'unknown'})`);
    const d = status.data;
    const skip = d.active !== true ? 'inactive' : d.today_checked_in === true ? 'already' : d.today_checked_in !== false ? 'unknown_status' : null;
    if (skip) return { code: 0, data: { gateway_skipped: skip, checkin: d } };
  }
  return request(ACCOUNT_ENDPOINTS[operation]);
}

module.exports = { queryWorkbuddyAccount, readWorkbuddySession, ACCOUNT_ENDPOINTS };

async function main() {
const installDir = process.env.WORKBUDDY_INSTALL_DIR;
const cliPath = process.env.WORKBUDDY_CLI_PATH;
if (!installDir || !cliPath) throw new Error('WorkBuddy install/CLI paths are required');
const { token, userId } = readWorkbuddySession(installDir, process.env.WORKBUDDY_AUTH_FILE);
process.env.CODEBUDDY_AUTH_TOKEN = token;
process.env.ACC_USER_ID = userId;
Object.assign(process.env, { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1', DISABLE_TELEMETRY: '1' });
const query = process.argv.indexOf('--gateway-query');
if (query >= 0) {
  const operation = process.argv[query + 1];
  let catalogHeaders;
  if (operation === 'catalog') {
    // Reproduce WorkbuddyClientInfoProvider/UserAgentHttpInterceptor using the
    // installed release versions, including the bundled CLI's placeholder rule.
    const appVersion = require(path.join(installDir, 'resources/app.asar/package.json')).version;
    const cliPackage = JSON.parse(fs.readFileSync(path.join(path.dirname(cliPath), '../package.json'), 'utf8'));
    const cliVersion = cliPackage.version === '0.0.0' ? cliPackage.publishConfig?.customPackage?.version : cliPackage.version;
    if (!appVersion || !cliVersion) throw new Error('WorkBuddy catalog client versions unavailable');
    catalogHeaders = { 'user-agent': `WorkBuddy/${appVersion} WorkBuddy/${appVersion} CLI/${cliVersion}`,
      'x-product': 'SaaS', 'x-requested-with': 'XMLHttpRequest' };
  }
  const data = await queryWorkbuddyAccount(operation, {
    token, userId,
    catalogHeaders,
  });
  if (operation === 'summary' && data.code === 0 && process.argv.includes('--gateway-observation')) {
    const { usageAccountKey } = await import('../src/usage-periods.js');
    data.gatewayAccountKey = usageAccountKey('workbuddy', userId);
  }
  console.log(JSON.stringify(data));
} else {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    try {
      const event = JSON.parse(String(chunk));
      if (event.type === 'system' && event.subtype === 'init') {
        // Fail closed if a future client release injects local/business tools.
        if ((event.tools || []).length || (event.mcp_servers || []).length) {
          process.stderr.write('WorkBuddy gateway refused a CLI session with local tools or MCP servers enabled.\n');
          process.exit(1);
        }
        if (process.env.WORKBUDDY_VERIFY_TOOLS === '1') {
          write(JSON.stringify({ tools: event.tools, mcpServers: event.mcp_servers, model: event.model }) + '\n');
          process.exit(0);
        }
      }
    } catch {}
    return write(chunk, ...rest);
  };
  process.argv = [process.execPath, path.resolve(cliPath), ...process.argv.slice(2)];
  require(cliPath);
}
}

if (require.main === module) main().catch((error) => {
  console.error(String(error.message).replace(/(Bearer\s+)\S+/gi, '$1[redacted]'));
  process.exitCode = 1;
});
