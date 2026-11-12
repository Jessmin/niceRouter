import { createHash } from 'node:crypto';
import { getMiniMaxCodeAuth, readMiniMaxCodeDesktopVersion } from './minimax-code-auth.js';
import { creditObservation, usageAccountKey } from './usage-periods.js';

const PROVIDER = 'minimax-code';
const STATUS_PATH = '/minimax-cloud/api/v1/signin/status';
const CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim';
const CREDIT_PATH = '/minimax-cloud/api/v1/credit/details';
const MEMBERSHIP_PATH = '/matrix/api/v1/commerce/get_membership_info';
const USER_PATH = '/v1/api/user/info';
const ORIGINS = {
  cn: { matrix: 'https://agent.minimax.cn', checkin: 'https://agent.minimaxi.com' },
  global: { matrix: 'https://agent.minimax.io', checkin: 'https://agent.minimax.io' },
};
const TIMEOUT_MS = 12000;
const CLAIMABLE = 2;
const CLAIMED = 3;
const md5 = (value) => createHash('md5').update(value).digest('hex');
const beijingDay = (time) => new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const campaignId = (account) => createHash('sha256').update(`${PROVIDER}/${account.region}/${account.userId}`).digest('hex');

function credit(value) {
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizePanel(panel, account, day) {
  const days = panel?.days;
  if (!Number.isInteger(panel?.scene) || panel.scene < 0 || panel.scene > 4
    || !Array.isArray(days) || days.length !== 7
    || new Set(days.map((item) => item?.day_no)).size !== 7
    || days.some((item) => !Number.isInteger(item?.day_no) || item.day_no < 1 || item.day_no > 7
      || ![1, CLAIMABLE, CLAIMED, 4].includes(item.status) || typeof item.is_today !== 'boolean'
      || !Number.isFinite(item.points) || item.points < 0)
    || days.filter((item) => item.is_today).length > 1
    || days.filter((item) => item.status === CLAIMABLE).length > 1) {
    throw new Error('MiniMax Code 签到面板格式无效');
  }

  const today = days.find((item) => item.is_today);
  const claimable = today?.status === CLAIMABLE;
  const done = today?.status === CLAIMED ? true : claimable ? false : null;
  return {
    provider: PROVIDER, supported: true, claimSupported: true, active: Boolean(today), day, done, claimable,
    dayNumber: today?.day_no ?? null,
    nextReward: claimable ? { amount: today.points, title: '每日签到积分' } : null,
    campaigns: today ? [{ id: campaignId(account), claimable }] : [],
    reason: done === null ? '上游未开放当日签到领取' : undefined,
  };
}

function assertExpectedStatus(expected, day, id) {
  if (expected === undefined) return;
  if (expected?.day !== day) throw new Error('MiniMax Code 签到日期已切换，请重新查询');
  if (!id || !Array.isArray(expected.campaigns)
    || !expected.campaigns.some((campaign) => campaign?.id === id && campaign.claimable === true)) {
    throw new Error('MiniMax Code 签到账户或活动已切换，请重新查询');
  }
}

export function createMiniMaxCodeAccount({
  readAuth = getMiniMaxCodeAuth,
  readVersion = readMiniMaxCodeDesktopVersion,
  fetchImpl = globalThis.fetch,
  now = Date.now,
} = {}) {
  const claims = new Map();

  async function request(path, account, { method = 'GET', version, query = {} } = {}) {
    const isCheckin = version !== undefined;
    const url = new URL(path, ORIGINS[account.region][isCheckin ? 'checkin' : 'matrix']);
    const timestamp = now();
    const seconds = Math.floor(timestamp / 1000);
    const lang = account.region === 'cn' ? 'zh' : 'en';
    const body = method === 'POST' ? '{}' : undefined;
    url.search = new URLSearchParams({
      ...query,
      device_platform: 'web', biz_id: '3', app_id: '3001', version_code: '22201', is_desktop: '1',
      unix: String(timestamp), timezone_offset: '28800', sys_language: lang, lang,
      device_id: '0', user_id: account.userId, client: isCheckin ? 'mcode' : 'desktop',
      ...(isCheckin
        ? { desktop_version: version, os_name: process.platform, browser_name: 'mcode', timezone_id: 'Asia/Shanghai' }
        : { region: account.region === 'cn' ? 'cn' : 'en' }),
    }).toString();
    const headers = {
      Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'MiniMaxCode',
      Authorization: `Bearer ${account.accessToken}`,
      // First-party client attribution protocol shared by the published TUI and Desktop.
      yy: md5(`${encodeURIComponent(url.pathname + url.search)}_${body ?? '{}'}${md5(String(timestamp))}ooui`),
      'x-timestamp': String(seconds),
      'x-signature': md5(`${seconds}I*7Cf%WZ#S&%1RlZJ&C2${body ?? ''}`),
    };
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url, { method, headers, body, signal, redirect: 'error' });
    } catch {
      throw new Error(`MiniMax Code 账户请求${signal.aborted ? '超时' : '失败'}`);
    }
    if (!response.ok) throw new Error(`MiniMax Code 账户请求 HTTP ${response.status}`);
    const envelope = await response.json().catch(() => null);
    const data = envelope?.data ?? envelope;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('MiniMax Code 账户返回格式无效');
    const code = envelope?.base_resp?.status_code ?? envelope?.statusInfo?.code ?? data.base_resp?.status_code;
    if (code !== undefined && code !== 0) {
      throw new Error(Number.isInteger(code) ? `MiniMax Code 账户接口错误 (${code})` : 'MiniMax Code 账户返回状态无效');
    }
    return data;
  }

  async function getAccount(cfg, expected) {
    const region = cfg.region === 'en' ? 'global' : cfg.region || 'cn';
    if (!Object.hasOwn(ORIGINS, region)) throw new Error('MiniMax Code 账户地区配置无效');
    const auth = await readAuth({ region, dataDir: cfg.dataDir, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!auth?.accessToken) throw new Error('MiniMax Code 账户未登录或授权已过期');
    if (expected?.accessToken === auth.accessToken && expected.region === region) return expected;

    const account = { region, accessToken: auth.accessToken, userId: '0' };
    const result = await request(USER_PATH, account);
    const user = result.userInfo ?? result.user_info;
    const id = user?.realUserID ?? user?.real_user_id;
    if ((typeof id !== 'string' && !Number.isSafeInteger(id)) || !/^\d+$/.test(String(id)) || String(id) === '0') {
      throw new Error('MiniMax Code 未返回有效的账户身份');
    }
    account.userId = String(id);
    if (expected && (expected.region !== account.region || expected.userId !== account.userId)) {
      throw new Error('MiniMax Code 签到期间登录账户已切换');
    }
    return account;
  }

  function getVersion(cfg) {
    const version = cfg.appVersion ?? readVersion(cfg.installDir);
    if (typeof version !== 'string' || !version.trim()) throw new Error('MiniMax Code 未找到官方客户端版本');
    return version.trim();
  }

  async function getStatus(account, version) {
    const day = beijingDay(now());
    return normalizePanel(await request(STATUS_PATH, account, { version }), account, day);
  }

  async function claim(cfg, account, version, day, expectedStatus) {
    const before = await getStatus(account, version);
    if (before.day !== day || beijingDay(now()) !== day) throw new Error('MiniMax Code 签到日期已切换，请重新查询');
    assertExpectedStatus(expectedStatus, before.day, before.campaigns[0]?.id);
    if (before.done) return { ok: true, ...before, already: true, skipped: true, skipReason: 'already' };
    if (!before.claimable) return { ok: true, ...before, skipped: true, skipReason: 'inactive' };

    account = await getAccount(cfg, account);
    if (beijingDay(now()) !== before.day) throw new Error('MiniMax Code 签到日期已切换，请重新查询');
    try {
      const result = await request(CLAIM_PATH, account, { method: 'POST', version });
      const after = normalizePanel(result.panel, account, before.day);
      if (![1, 2].includes(result.claim_result) || typeof result.claim_id !== 'string' || !result.claim_id
        || result.day_no !== before.dayNumber || after.dayNumber !== before.dayNumber || after.done !== true
        || !Number.isFinite(result.points) || result.points < 0 || !Number.isFinite(result.expire_at_ms)) {
        throw new Error('MiniMax Code 签到结果未得到上游确认');
      }
      await getAccount(cfg, account);
      if (beijingDay(now()) !== before.day) throw new Error('MiniMax Code 签到日期已切换，请重新查询');
      if (result.claim_result === 2) return { ok: true, ...after, already: true };
      return { ok: true, ...after, claimed: [{ ok: true, amount: result.points, expiresAtMs: result.expire_at_ms }] };
    } catch (error) {
      // A failed response may follow a committed claim. Confirm by reading once.
      const after = await getAccount(cfg, account).then((current) => getStatus(current, version)).catch(() => null);
      if (after?.done && after.day === before.day && after.dayNumber === before.dayNumber) {
        return { ok: true, ...after, already: true, recovered: true };
      }
      throw error;
    }
  }

  async function checkin(opts = {}, cfg = {}) {
    const account = await getAccount(cfg);
    const version = getVersion(cfg);
    if (opts.action !== 'claim') return { ok: true, ...await getStatus(account, version) };
    const day = beijingDay(now());
    const id = campaignId(account);
    assertExpectedStatus(opts.expectedStatus, day, id);
    const key = `${id}/${day}`;
    if (!claims.has(key)) {
      claims.set(key, claim(cfg, account, version, day, opts.expectedStatus).finally(() => claims.delete(key)));
    }
    const result = await claims.get(key);
    assertExpectedStatus(opts.expectedStatus, result.day, result.campaigns[0]?.id);
    return result;
  }

  async function getCreditBalance(account) {
    const asOf = now();
    const totals = { total: 0, used: 0, remaining: 0 };
    const counters = [];
    let count = 0;
    for (let page = 1; page <= 20; page += 1) {
      const data = await request(CREDIT_PATH, account, {
        query: { page_number: String(page), page_size: '100', include_expired: 'false' },
      });
      const expected = credit(data.total_count);
      if (!Array.isArray(data.details) || !Number.isSafeInteger(expected)) break;
      for (const row of data.details) {
        const expiry = credit(row?.expire_at_ms);
        const total = credit(row?.granted_amount);
        const used = credit(row?.consumed_amount);
        const remaining = credit(row?.remaining_amount);
        if ([expiry, total, used, remaining].includes(null)) throw new Error('MiniMax Code 积分批次格式无效');
        if (expiry > 0 && expiry <= asOf) continue;
        totals.total += total;
        totals.used += used;
        totals.remaining += remaining;
        const type = credit(row.credit_type);
        const grantedAt = credit(row.granted_at_ms);
        if (Number.isSafeInteger(type) && Number.isSafeInteger(grantedAt) && grantedAt > 0) {
          counters.push([JSON.stringify([type, grantedAt, expiry, total]), used]);
        }
      }
      count += data.details.length;
      if (count === expected) return { ...totals, counters };
      if (!data.details.length || count > expected) break;
    }
    throw new Error('MiniMax Code 积分批次不完整');
  }

  async function quota(cfg = {}) {
    const account = await getAccount(cfg);
    const [membership, balance, panel] = await Promise.allSettled([
      request(MEMBERSHIP_PATH, account, { method: 'POST' }),
      getCreditBalance(account),
      Promise.resolve().then(() => getStatus(account, getVersion(cfg))),
    ]);
    const plan = membership.value;
    const credits = balance.value;
    if (!plan && !credits) throw balance.reason;

    const planRemaining = credit(plan?.total_remains_credit);
    const remaining = credits?.remaining ?? planRemaining;
    const items = [];
    if (planRemaining !== null) items.push({ label: '会员接口余额', value: planRemaining });
    const opBalance = credit(plan?.opcredit_balance);
    if (plan?.has_token_plan === true && opBalance !== null) items.push({ label: 'Token Plan 余额', value: opBalance });
    const observedAccount = credits && usageAccountKey(PROVIDER, `${account.region}/${account.userId}`);
    return {
      provider: PROVIDER,
      plan: typeof plan?.plan_name === 'string' && plan.plan_name ? plan.plan_name : 'MiniMax Code',
      total: credits?.total ?? null, used: credits?.used ?? null, remaining, quota: remaining,
      ratio: credits?.total ? credits.used / credits.total : null,
      quotaSource: credits ? 'active-credit-grants' : 'membership',
      unit: 'credits', items,
      checkin: panel.value ?? { error: panel.reason.message },
      ...(observedAccount && { [creditObservation]: { account: observedAccount, method: 'snapshot', counters: credits.counters } }),
    };
  }

  return { checkin, quota };
}

const account = createMiniMaxCodeAccount();
export const minimaxCheckin = account.checkin;
export const minimaxQuota = account.quota;
