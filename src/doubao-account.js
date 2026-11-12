import { createHash } from 'node:crypto';

const BASIC_PATH = '/alice/basic/launch';
const LANDING_PATH = '/alice/ug/campaign/landing/get';
const DETAIL_PATH = '/alice/ug/campaign/v3/detail/';
const V3_SCENE = 'pc_incentive_task_mvp_v3';
const CLAIM_PATH = '/alice/ug/campaign/landing/checkin';
const QUOTA_PATH = '/alice/commerce/sale/subscription/quota/summary/';
const REWARD_STATES = { 1: 'pending', 2: 'processing', 3: 'succeeded', 4: 'failed' };
const beijingDay = (time) => new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const failure = (message, code = 'doubao_checkin_invalid') => Object.assign(new Error(message), { code });

function rewardFromTitle(title) {
  if (typeof title !== 'string') return null;
  const amounts = [...title.matchAll(/<font\b[^>]*>\s*(\d+(?:\.\d+)?)\s*<\/font>\s*额度/gi)];
  if (amounts.length !== 1) return null;
  const amount = Number(amounts[0][1]);
  return Number.isFinite(amount) && amount >= 0 ? { amount, unit: '额度', title: '每日签到' } : null;
}

function dailyTask(data, scene) {
  if (data?.campaign_code !== scene || !Array.isArray(data?.tasks)) return null;
  const candidates = data.tasks.filter((task) => task?.campaign_code === 'daily_signin' || task?.task_kind === 'daily_signin');
  if (candidates.length !== 1) return null;
  const task = candidates[0];
  return task.campaign_code === 'daily_signin' && task.task_kind === 'daily_signin'
    && task.campaign_group_code === scene ? task : null;
}

function rewardFromDaily(task) {
  const reward = task?.daily_checkin?.reward;
  return reward?.reward_type === 'quota_grant' && typeof reward.reward_amount === 'number'
    && Number.isFinite(reward.reward_amount) && reward.reward_amount >= 0
    ? { amount: reward.reward_amount, unit: '额度', title: '每日签到' } : null;
}

function rewardState(code) {
  const known = Number.isInteger(code) && Object.hasOwn(REWARD_STATES, code);
  return { rewardStatus: known ? REWARD_STATES[code] : 'unknown', rewardStatusCode: known ? code : null,
    credited: code === 3 ? true : code === 4 ? false : null };
}

function unsupported(day) {
  return { ok: true, provider: 'doubao', day, supported: false, claimSupported: false,
    done: null, claimable: false, nextReward: null, unit: '额度',
    ...rewardState(null), campaigns: [], reason: '当前账号未返回可用的签到活动' };
}

function expectedMatches(expected, status) {
  if (!expected) return;
  if (expected.day !== undefined && expected.day !== status.day) {
    throw failure('豆包签到日期已变化，请重新查询', 'doubao_checkin_changed');
  }
  const previous = expected.campaigns?.[0]?.id;
  if (previous !== undefined && previous !== status.campaigns?.[0]?.id) {
    throw failure('豆包签到账号或活动已变化，请重新查询', 'doubao_checkin_changed');
  }
}

/** Official account requests are injected so status/claims share one authenticated client. */
export function createDoubaoAccount({ request, getAuth, now = Date.now } = {}) {
  if (typeof request !== 'function' || typeof getAuth !== 'function') throw new TypeError('request and getAuth are required');
  const statuses = new Map();
  const claims = new Map();
  const checked = new Map();

  async function account() {
    const auth = await getAuth();
    if (typeof auth?.accountKey !== 'string' || !auth.accountKey) {
      throw Object.assign(failure('豆包账号尚未登录或本机授权已过期', 'doubao_auth_missing'), { status: 401, type: 'authentication_error' });
    }
    return { key: auth.accountKey, day: beijingDay(now()) };
  }

  async function assertCurrent(identity) {
    const current = await account();
    if (current.key !== identity.key || current.day !== identity.day) {
      throw failure('豆包签到期间账号或日期已变化，请重新查询', 'doubao_checkin_changed');
    }
  }

  const keyFor = (identity) => `${identity.key}/${identity.day}`;

  async function loadStatus(identity) {
    const basic = await request(BASIC_PATH, {});
    await assertCurrent(identity);
    const value = basic?.ug_campaign_info?.campaign_group_code;
    const scene = typeof value === 'string' ? value.trim() : '';
    if (!scene || scene.length > 512 || /[\u0000-\u001f\u007f]/u.test(scene)) return { status: unsupported(identity.day), scene: null };
    let observedDone, observedClaimable, recognized, reward, observedReward;
    if (scene === V3_SCENE) {
      const data = await request(DETAIL_PATH, { campaign_group_code: scene });
      await assertCurrent(identity);
      const task = dailyTask(data, scene);
      const today = task?.daily_checkin?.checked_in_today;
      recognized = typeof today === 'boolean';
      observedDone = recognized ? today : null;
      observedClaimable = today === false;
      reward = rewardFromDaily(task);
      // V3 task status/mode and its offered quota are not delivery confirmations.
      observedReward = rewardState(null);
    } else {
      const data = await request(LANDING_PATH, { scene });
      await assertCurrent(identity);
      const chosen = data?.chosen_type;
      recognized = chosen === 1 || chosen === 2;
      observedDone = chosen === 2 ? true : chosen === 1 ? false : null;
      observedClaimable = Array.isArray(data?.main_page_info?.buttons)
        && data.main_page_info.buttons.some((button) => button?.button_type === 2);
      reward = rewardFromTitle(data?.main_page_info?.title);
      observedReward = rewardState(data?.reward_status);
    }
    const prior = checked.get(identity.key);
    const confirmed = prior?.day === identity.day && prior.scene === scene ? prior : null;
    const delivery = observedReward.rewardStatus === 'unknown' ? confirmed?.reward || observedReward : observedReward;
    if (scene === V3_SCENE && observedDone === true) {
      checked.set(identity.key, { day: identity.day, scene, reward: delivery });
    } else if (confirmed && observedReward.rewardStatus !== 'unknown') {
      checked.set(identity.key, { ...confirmed, reward: delivery });
    }
    const done = confirmed ? true : observedDone;
    const claimable = done === false && observedClaimable;
    const id = createHash('sha256').update(JSON.stringify(['doubao', identity.key, scene])).digest('hex');
    const status = { ok: true, provider: 'doubao', day: identity.day, supported: true, claimSupported: recognized,
      done, claimable, unit: '额度', nextReward: claimable ? reward : null,
      ...delivery,
      campaigns: [{ id, title: '每日签到', done, claimable, amount: reward?.amount ?? null, unit: '额度' }] };
    if (!recognized) status.reason = scene === V3_SCENE
      ? '上游未返回唯一且可识别的每日签到状态' : '上游未返回可识别的签到页面';
    return { status, scene };
  }

  function readStatus(identity) {
    const key = keyFor(identity);
    if (!statuses.has(key)) {
      statuses.set(key, loadStatus(identity).finally(() => statuses.delete(key)));
    }
    return statuses.get(key);
  }

  async function claim(identity, expected) {
    const { status: before, scene } = await readStatus(identity);
    expectedMatches(expected, before);
    if (before.done === true) return { ...before, already: true, skipped: true, after: before };
    if (!before.supported || !before.claimable) return { ...before, skipped: true, after: before };
    await assertCurrent(identity);
    let result;
    try {
      result = await request(CLAIM_PATH, { scene });
      await assertCurrent(identity);
      if (result?.checked_in !== true) throw failure('豆包签到未得到上游确认');
    } catch (error) {
      // A transport error may follow a committed write. Read once before any later retry.
      await assertCurrent(identity);
      const recovered = await readStatus(identity).catch(() => null);
      if (recovered?.status.done === true) {
        return { ...recovered.status, recovered: true, already: true, after: recovered.status };
      }
      throw error;
    }

    const reward = rewardState(result.reward_status);
    checked.set(identity.key, { day: identity.day, scene, reward });
    const fallback = { ...before, done: true, claimable: false, nextReward: null, ...reward,
      campaigns: before.campaigns.map((campaign) => ({ ...campaign, done: true, claimable: false })) };
    let after;
    try { after = (await readStatus(identity)).status; }
    catch { after = { ...fallback, statusRefreshFailed: true }; }
    if (after.done !== true) after = { ...fallback, statusRefreshIncomplete: true };
    await assertCurrent(identity);
    return { ...after, ok: true, checkedIn: true, after,
      ...(after.credited === true && before.nextReward
        ? { claimed: [{ ok: true, credited: true, ...before.nextReward }] } : {}) };
  }

  async function checkin(opts = {}) {
    const identity = await account();
    const key = keyFor(identity);
    if (opts.action === 'claim') {
      if (!claims.has(key)) claims.set(key, claim(identity, opts.expectedStatus).finally(() => claims.delete(key)));
      const result = await claims.get(key);
      expectedMatches(opts.expectedStatus, result);
      return result;
    }
    if (claims.has(key)) return (await claims.get(key)).after;
    return (await readStatus(identity)).status;
  }

  async function quota() {
    const identity = await account();
    const [membership, checkinStatus] = await Promise.all([
      request(QUOTA_PATH, { product_line: 'membership' }), checkin(),
    ]);
    await assertCurrent(identity);
    const label = membership?.current_subscription?.display?.product_name;
    const member = membership?.member_info;
    const subscribed = ['hasActiveSubscription', 'hasEnterpriseSubscription', 'has_business_subscription', 'has_team_subscription']
      .some((key) => member?.[key] === true);
    const plan = member?.hasActiveSubscription === false && !subscribed ? '未订阅'
      : typeof label === 'string' && label.trim() ? label.trim() : null;
    return { provider: 'doubao', plan,
      remaining: null, unit: '额度', balanceAvailable: false, checkin: checkinStatus,
      fetchedAt: new Date(now()).toISOString() };
  }

  return { quota, checkin };
}
