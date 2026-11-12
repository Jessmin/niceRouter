/** Installed WorkBuddy.exe + ELECTRON_RUN_AS_NODE=1. Read credentials through
 * the shipped native reader/crypto implementation, then use the official CLI's
 * CODEBUDDY_AUTH_TOKEN input. No package patch or plaintext credential file.
 */
const fs = require('node:fs');
const path = require('node:path');
const ACCOUNT_ENDPOINTS = Object.freeze({
  summary: '/billing/meter/get-user-resource-summary',
  checkin: '/billing/meter/checkin-status',
  claim: '/billing/meter/daily-checkin',
  catalog: '/v3/config',
});

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

module.exports = { queryWorkbuddyAccount, ACCOUNT_ENDPOINTS };

async function main() {
const installDir = process.env.WORKBUDDY_INSTALL_DIR;
const cliPath = process.env.WORKBUDDY_CLI_PATH;
if (!installDir || !cliPath) throw new Error('WorkBuddy install/CLI paths are required');
const cryptoApi = require(path.join(installDir, 'resources/app.asar/main/app-lifetime-job.js'));
cryptoApi.D();
const caps = cryptoApi.G(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
if (caps.symmetric.status !== 'available') throw new Error('WorkBuddy native credential key is unavailable');
const session = JSON.parse(fs.readFileSync(process.env.WORKBUDDY_AUTH_FILE, 'utf8'));
const codec = new cryptoApi.R(caps.symmetric.value);
function readField(value) {
  if (typeof value === 'string') return value;
  if (value?.$wbEncrypted !== 1 || value.scheme) throw new Error('Unsupported WorkBuddy credential format');
  const bytes = codec.open(cryptoApi.K(Buffer.from(value.envelope, 'base64')), { framing: 'field' });
  try { return bytes.toString('utf8'); } finally { bytes.fill(0); }
}
try {
  process.env.CODEBUDDY_AUTH_TOKEN = readField(session.auth.accessToken);
  process.env.ACC_USER_ID = session.account?.uid || '';
} finally { codec.dispose(); caps.symmetric.value.key.fill(0); }
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
    token: process.env.CODEBUDDY_AUTH_TOKEN, userId: session.account.uid,
    catalogHeaders,
  });
  if (operation === 'summary' && data.code === 0 && process.argv.includes('--gateway-observation')) {
    const { usageAccountKey } = await import('../src/usage-periods.js');
    data.gatewayAccountKey = usageAccountKey('workbuddy', session.account.uid);
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
