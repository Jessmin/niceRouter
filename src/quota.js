import { config } from './config.js';
import { creditObservation, usageAccountKey } from './usage-periods.js';

/**
 * Trae 积分 / 权益查询
 * ------------------------------------------------------------------
 * 域名注意：模型对话在 api5-normal.mchost.guru，但支付/积分在 https://api.trae.cn
 * （抓包 151742-005/007 实证，用错域名 404）
 *
 * POST /trae/api/v2/pay/ide_user_pay_status
 *   body {trae_client:'IDE', device_id}  -> 顶层 user_pay_identity_str / detail.fast_request_per
 * POST /trae/api/v2/pay/ide_user_ent_usage
 *   body {require_usage:true, req_source:1}
 *     -> usage_summary {consumed_amount, consumption_ratio, total_amount}
 *     -> user_entitlement_pack_list[]（各积分包明细）
 *
 * 每日签到（TRAE CN IDE，客户端 main.js 与只读实测确认）：
 * POST /trae/api/v2/ug/checkin_credits/status  body {req_source:1}
 * POST /trae/api/v2/ug/checkin_credits/claim   body {req_source:1}
 * trae / solo 共享同一个账号、同一次签到，只有显式 action=claim 才领取。
 */

const PAY_BASE = config.trae.payBase;

async function post(path, body) {
  const res = await fetch(PAY_BASE + path, {
    method: 'POST',
    headers: { ...config.trae.headers, 'content-type': 'application/json', 'accept-encoding': 'identity' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const data = await res.json();
  if (Object.hasOwn(data, 'code') && data.code !== 0) {
    throw new Error(`Trae ${data.code}: ${data.message || '上游业务请求失败'}`);
  }
  return data;
}

const CHECKIN_PATH = '/trae/api/v2/ug/checkin_credits';
const beijingDay = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
let statusRequest = null;
let claimRequest = null;

/** 状态查询只读；并行查询 trae/solo 时合并同一账号的在途请求。 */
export async function traeCheckinStatus({ fresh = false } = {}) {
  if (!config.trae.token) return null;
  if (statusRequest && !fresh) return statusRequest;
  const request = (async () => {
    const data = await post(`${CHECKIN_PATH}/status`, { req_source: 1 });
    if (typeof data.enable !== 'boolean' || typeof data.checked_in !== 'boolean') {
      throw new Error('Trae 签到状态响应缺少 enable / checked_in');
    }
    const done = data.checked_in || data.did_checked_in === true;
    const credits = Number.isFinite(data.credits) && data.credits > 0 ? data.credits : null;
    const extraCredits = Number.isFinite(data.extra_credits) && data.extra_credits > 0 ? data.extra_credits : null;
    return {
      provider: 'trae',
      accountGroup: 'trae',
      supported: true,
      enabled: data.enable,
      done,
      claimable: data.enable && !done,
      day: beijingDay(),
      streak: null,
      credits,
      extraCredits,
      nextReward: data.enable && !done && credits != null
        ? { amount: credits, title: '每日签到', unit: 'credits' }
        : null,
    };
  })();
  statusRequest = request;
  try {
    return await request;
  } finally {
    if (statusRequest === request) statusRequest = null;
  }
}

/** 默认只查状态；仅 action=claim 执行领取，不连带执行抽奖等其它活动。 */
export async function traeCheckin(opts = {}) {
  if (opts.action !== 'claim') return traeCheckinStatus();
  if (claimRequest) return claimRequest;
  const request = (async () => {
    const before = await traeCheckinStatus();
    if (!before) return { ok: false, error: 'Trae token 未配置' };
    if (before.done) return { ok: true, already: true, ...before };
    if (!before.enabled) return { ok: false, error: '当前账号的 Trae 签到活动未启用', ...before };
    await post(`${CHECKIN_PATH}/claim`, { req_source: 1 });
    // 写操作成功后，查询失败也保留已领取的事实，避免鼓励用户再次点击。
    const after = await traeCheckinStatus({ fresh: true }).catch(() => null);
    return {
      ok: true,
      provider: 'trae',
      accountGroup: 'trae',
      claimed: [{ title: '每日签到', amount: before.credits, ok: true }],
      after,
    };
  })();
  claimRequest = request;
  try {
    return await request;
  } finally {
    if (claimRequest === request) claimRequest = null;
  }
}

export async function traeQuota() {
  const deviceId = config.trae.deviceId;
  const [status, usage, checkin] = await Promise.all([
    post('/trae/api/v2/pay/ide_user_pay_status', { trae_client: 'IDE', ...(deviceId && { device_id: deviceId }) }),
    post('/trae/api/v2/pay/ide_user_ent_usage', { require_usage: true, req_source: 1 }),
    traeCheckinStatus().catch((e) => ({ error: String(e.message || e) })),
  ]);

  const s = usage.usage_summary || {};
  const entitlements = usage.user_entitlement_pack_list || [];
  const packs = entitlements.map((p) => {
    const q = p.entitlement_base_info?.quota || {};
    return {
      name: p.display_desc || p.group_name || '积分包',
      limit: q.credits_limit ?? null,
      expire: p.expire_time ? new Date(p.expire_time * 1000).toISOString().slice(0, 10) : null,
    };
  });
  const owners = new Set(entitlements.map((p) => p.entitlement_base_info?.user_id).filter(Boolean));
  const account = owners.size === 1 ? usageAccountKey('trae', owners.values().next().value) : null;
  const counters = entitlements.flatMap((p) => {
    const base = p.entitlement_base_info;
    if (!base?.entitlement_id || !base.quota?.credits_limit) return [];
    return [[JSON.stringify([p.source_id, base.entitlement_id, base.start_time, base.end_time]), p.usage?.credits_amount ?? 0]];
  });

  return {
    plan: status.user_pay_identity_str || 'Unknown',
    fastRequests: status.detail?.fast_request_per ?? null,
    total: s.total_amount ?? null,
    used: s.consumed_amount ?? null,
    [creditObservation]: { account, method: 'snapshot', counters },
    ratio: s.consumption_ratio ?? null,
    packs,
    checkin,
  };
}
