/** Offline account fixtures. All status and claim requests use an injected local stub. */
import assert from 'node:assert/strict';
import { createDoubaoAccount } from '../src/doubao-account.js';
import { createAutoCheckin } from '../src/auto-checkin.js';

const BASIC = '/alice/basic/launch';
const LANDING = '/alice/ug/campaign/landing/get';
const DETAIL = '/alice/ug/campaign/v3/detail/';
const V3_SCENE = 'pc_incentive_task_mvp_v3';
const CLAIM = '/alice/ug/campaign/landing/checkin';
const QUOTA = '/alice/commerce/sale/subscription/quota/summary/';
const initialTime = Date.UTC(2026, 10, 9, 2);
let passed = 0;
const test = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };

// Public field structure observed in the native V3 task-page response, without account data.
function dailyDetail(checkedInToday = false) {
  return { campaign_code: V3_SCENE, progress: { total_amount: 0 }, tasks: [{
    campaign_code: 'daily_signin', campaign_group_code: V3_SCENE, task_kind: 'daily_signin',
    task_status: checkedInToday ? 3 : 1, reward_mode: 2, title: '每日签到', subtitle: '',
    daily_checkin: { checked_in_today: checkedInToday, continuous_days: 0, total_days: 0,
      reward: { reward_amount: 400, reward_type: 'quota_grant' } },
  }] };
}

function fixture(options = {}) {
  let time = initialTime, accountKey = 'a'.repeat(64);
  const completed = new Set();
  const periodKey = () => `${accountKey}/${new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)}`;
  const calls = [];
  const state = { scene: 'fixture_campaign', chosen: 1, buttons: [{ button_type: 2 }],
    title: "今日签到领 <font type='highlight'>400</font> 额度", reward: 3, checkedIn: true, ...options };
  const getAuth = async () => accountKey ? { accountKey } : null;
  const request = async (path, body) => {
    calls.push({ path, body });
    if (state.onRequest) await state.onRequest(path, body);
    if (path === BASIC) return { ug_campaign_info: { campaign_group_code: state.scene } };
    if (path === LANDING) {
      const claimed = completed.has(periodKey());
      if (claimed && state.failAfter) throw new Error('fixture status unavailable');
      return { chosen_type: claimed ? 2 : state.chosen,
        ...(state.landingReward !== undefined ? { reward_status: state.landingReward } : {}),
        main_page_info: { title: state.title, buttons: state.buttons } };
    }
    if (path === DETAIL) {
      if (completed.has(periodKey()) && state.failAfter) throw new Error('fixture status unavailable');
      return state.detail !== undefined ? structuredClone(state.detail) : dailyDetail(completed.has(periodKey()));
    }
    if (path === CLAIM) {
      if (state.throwBefore) throw new Error('fixture write failed');
      if (state.checkedIn) completed.add(periodKey());
      if (state.throwAfter) throw new Error('fixture committed then disconnected');
      return { checked_in: state.checkedIn, reward_status: state.reward };
    }
    if (path === QUOTA) return state.membership || {};
    assert.fail(`Unexpected request ${path}`);
  };
  return { adapter: createDoubaoAccount({ request, getAuth, now: () => time }), state, calls,
    setTime: (value) => { time = value; }, setAccount: (value) => { accountKey = value; } };
}

await test('dynamic campaign and exact font-wrapped quota reward', async () => {
  const f = fixture();
  const status = await f.adapter.checkin();
  assert.equal(status.day, '2026-11-09'); assert.equal(status.supported, true);
  assert.equal(status.done, false); assert.equal(status.claimable, true);
  assert.deepEqual(status.nextReward, { amount: 400, unit: '额度', title: '每日签到' });
  assert.deepEqual(f.calls, [{ path: BASIC, body: {} }, { path: LANDING, body: { scene: 'fixture_campaign' } }]);
});
await test('absent campaign and unknown page remain unknown', async () => {
  const missing = fixture({ scene: ' ' }); const status = await missing.adapter.checkin({ action: 'claim' });
  assert.equal(status.supported, false); assert.equal(status.done, null); assert.equal(status.claimable, false);
  assert.equal(missing.calls.length, 1);
  const unknown = await fixture({ chosen: 9 }).adapter.checkin();
  assert.equal(unknown.done, null); assert.equal(unknown.claimSupported, false); assert.equal(unknown.claimable, false);
});
await test('plain title, foreign unit, and ambiguous amounts never invent quota', async () => {
  for (const title of ['签到领400额度', '<font>400</font>积分', '<font>400</font>额度 <font>100</font>额度', null]) {
    assert.equal((await fixture({ title }).adapter.checkin()).nextReward, null);
  }
});
await test('button and already-complete page prevent claim', async () => {
  for (const options of [{ buttons: [{ button_type: 1 }] }, { chosen: 2 }]) {
    const f = fixture(options); const status = await f.adapter.checkin({ action: 'claim' });
    assert.equal(status.claimable, false); assert.ok(!f.calls.some(({ path }) => path === CLAIM));
    if (options.chosen === 2) { assert.equal(status.done, true); assert.equal(status.already, true); }
  }
});
await test('concurrent status reads share one upstream pair', async () => {
  const f = fixture(); const statuses = await Promise.all(Array.from({ length: 8 }, () => f.adapter.checkin()));
  assert.ok(statuses.every((status) => status.claimable)); assert.equal(f.calls.length, 2);
});
await test('concurrent claims write once and later claims remain idempotent', async () => {
  const f = fixture(); const results = await Promise.all(Array.from({ length: 8 }, () => f.adapter.checkin({ action: 'claim' })));
  assert.ok(results.every((result) => result.ok && result.done && result.credited));
  assert.equal(f.calls.filter(({ path }) => path === CLAIM).length, 1);
  assert.equal(results[0].claimed[0].amount, 400);
  assert.equal((await f.adapter.checkin({ action: 'claim' })).already, true);
  assert.equal(f.calls.filter(({ path }) => path === CLAIM).length, 1);
});
await test('reward delivery states stay distinct from checked-in status', async () => {
  for (const [code, label] of [[1, 'pending'], [2, 'processing'], [3, 'succeeded'], [4, 'failed'], [99, 'unknown']]) {
    const f = fixture({ reward: code }); const result = await f.adapter.checkin({ action: 'claim' });
    assert.equal(result.done, true); assert.equal(result.rewardStatus, label);
    assert.equal(result.credited, code === 3 ? true : code === 4 ? false : null);
    assert.equal(Boolean(result.claimed), code === 3);
    const later = await f.adapter.checkin(); assert.equal(later.rewardStatus, label); assert.equal(later.claimable, false);
  }
});
await test('unchecked response never reports a successful claim', async () => {
  const f = fixture({ checkedIn: false });
  await assert.rejects(f.adapter.checkin({ action: 'claim' }), /未得到上游确认/);
  assert.equal((await f.adapter.checkin()).done, false);
});
await test('write disconnect is recovered only from a completed landing page', async () => {
  const committed = fixture({ throwAfter: true });
  const result = await committed.adapter.checkin({ action: 'claim' });
  assert.equal(result.done, true); assert.equal(result.recovered, true); assert.equal(result.credited, null);
  const rejected = fixture({ throwBefore: true });
  await assert.rejects(rejected.adapter.checkin({ action: 'claim' }), /fixture write failed/);
  assert.equal((await rejected.adapter.checkin()).done, false);
});
await test('confirmed check-in survives failed status refresh without awarding credit', async () => {
  const f = fixture({ reward: 4, failAfter: true }); const result = await f.adapter.checkin({ action: 'claim' });
  assert.equal(result.done, true); assert.equal(result.credited, false); assert.equal(result.statusRefreshFailed, true);
});
await test('confirmed check-in survives incomplete after-page without another claim', async () => {
  const f = fixture({ reward: 1 });
  f.state.onRequest = async (path) => { if (path === CLAIM) f.state.scene = ''; };
  const result = await f.adapter.checkin({ action: 'claim' });
  assert.equal(result.done, true); assert.equal(result.credited, null); assert.equal(result.statusRefreshIncomplete, true);
});
await test('later reported reward status can progress without re-claiming', async () => {
  const f = fixture({ reward: 1 });
  assert.equal((await f.adapter.checkin({ action: 'claim' })).rewardStatus, 'pending');
  f.state.landingReward = 3;
  const later = await f.adapter.checkin(); assert.equal(later.rewardStatus, 'succeeded'); assert.equal(later.credited, true);
  assert.equal(f.calls.filter(({ path }) => path === CLAIM).length, 1);
});
await test('expected campaign/day and account switches prevent stale claims', async () => {
  const f = fixture(); const before = await f.adapter.checkin();
  f.state.scene = 'another_campaign';
  await assert.rejects(f.adapter.checkin({ action: 'claim', expectedStatus: before }), { code: 'doubao_checkin_changed' });
  assert.ok(!f.calls.some(({ path }) => path === CLAIM));
  const other = fixture(); other.state.onRequest = async (path) => { if (path === BASIC) other.setAccount('b'.repeat(64)); };
  await assert.rejects(other.adapter.checkin({ action: 'claim' }), { code: 'doubao_checkin_changed' });
});
await test('Beijing day rollover and fresh account keep their own claim periods', async () => {
  const f = fixture(); f.setTime(Date.UTC(2026, 10, 9, 15, 59, 59));
  const before = await f.adapter.checkin(); assert.equal(before.day, '2026-11-09');
  f.setTime(Date.UTC(2026, 10, 9, 16, 0, 0));
  await assert.rejects(f.adapter.checkin({ action: 'claim', expectedStatus: before }), { code: 'doubao_checkin_changed' });
  const after = await f.adapter.checkin({ action: 'claim' }); assert.equal(after.day, '2026-11-10');
  const other = fixture(); const first = await other.adapter.checkin({ action: 'claim' });
  other.setAccount('b'.repeat(64)); const second = await other.adapter.checkin();
  assert.notEqual(first.campaigns[0].id, second.campaigns[0].id);
  assert.equal(second.done, false);
  other.setAccount('a'.repeat(64)); other.setTime(initialTime + 24 * 60 * 60 * 1000);
  assert.equal((await other.adapter.checkin()).claimable, true);
  assert.equal((await other.adapter.checkin({ action: 'claim' })).done, true);
  assert.equal(other.calls.filter(({ path }) => path === CLAIM).length, 2);
});
await test('membership display never becomes an inferred balance', async () => {
  for (const membership of [{}, { current_subscription: { display: { product_name: 'Fixture plan' }, agreement_price: 999 }, window_limit_section: {} }]) {
    const f = fixture({ membership }); const quota = await f.adapter.quota();
    assert.equal(quota.remaining, null); assert.equal(quota.unit, '额度'); assert.equal(quota.balanceAvailable, false);
    assert.equal(quota.plan, membership.current_subscription ? 'Fixture plan' : null);
    assert.deepEqual(f.calls.find(({ path }) => path === QUOTA).body, { product_line: 'membership' });
  }
});
await test('missing login fails before account endpoints run', async () => {
  const f = fixture(); f.setAccount(null);
  await assert.rejects(f.adapter.checkin(), { code: 'doubao_auth_missing' }); assert.equal(f.calls.length, 0);
});
await test('inactive membership does not advertise the promotional subscription label', async () => {
  const f = fixture({ membership: { current_subscription: { display: { product_name: '个人订阅' } },
    member_info: { hasActiveSubscription: false, hasEnterpriseSubscription: false,
      has_business_subscription: false, has_team_subscription: false } } });
  assert.equal((await f.adapter.quota()).plan, '未订阅');
});
await test('automatic scheduler confirms checked-in and avoids a second write', async () => {
  const f = fixture({ reward: 4 });
  const scheduler = createAutoCheckin({ enabled: true, now: () => initialTime,
    getProviders: () => [{ name: 'doubao', accountKey: 'fixture-doubao', adapter: f.adapter }] });
  const first = await scheduler.run();
  assert.equal(first.providers.doubao.done, true); assert.equal(first.providers.doubao.phase, 'signed');
  assert.equal((await f.adapter.checkin()).credited, false);
  await scheduler.run(); assert.equal(f.calls.filter(({ path }) => path === CLAIM).length, 1);
});

await test('native V3 daily structure is authoritative instead of the popup page', async () => {
  const f = fixture({ scene: V3_SCENE, chosen: 2, landingReward: 3 });
  const status = await f.adapter.checkin();
  assert.equal(status.supported, true); assert.equal(status.claimSupported, true);
  assert.equal(status.done, false); assert.equal(status.claimable, true);
  assert.deepEqual(status.nextReward, { amount: 400, unit: '额度', title: '每日签到' });
  assert.equal(status.credited, null); assert.equal(status.rewardStatus, 'unknown');
  assert.deepEqual(f.calls, [{ path: BASIC, body: {} }, { path: DETAIL, body: { campaign_group_code: V3_SCENE } }]);
});
await test('V3 checked-in today prevents a write without implying quota delivery', async () => {
  const f = fixture({ scene: V3_SCENE, detail: dailyDetail(true) });
  const result = await f.adapter.checkin({ action: 'claim' });
  assert.equal(result.done, true); assert.equal(result.claimable, false); assert.equal(result.already, true);
  assert.equal(result.nextReward, null); assert.equal(result.credited, null);
  assert.equal(result.claimed, undefined); assert.ok(!f.calls.some(({ path }) => path === CLAIM));
});
await test('V3 status and reward mode never substitute for the true daily flag', async () => {
  const detail = dailyDetail(false);
  detail.tasks[0].task_status = 3; detail.tasks[0].reward_mode = 2;
  const f = fixture({ scene: V3_SCENE, detail });
  const status = await f.adapter.checkin();
  assert.equal(status.done, false); assert.equal(status.claimable, true); assert.equal(status.credited, null);
});
await test('V3 missing, nonboolean and ambiguous daily state cannot trigger claims', async () => {
  const invalid = [undefined, null, 0, 1, 'false', 'true'];
  for (const value of invalid) {
    const detail = dailyDetail(value);
    // dailyDetail's default is intentionally overridden for an absent value.
    detail.tasks[0].daily_checkin.checked_in_today = value;
    const f = fixture({ scene: V3_SCENE, chosen: 2, detail });
    const result = await f.adapter.checkin({ action: 'claim' });
    assert.equal(result.done, null); assert.equal(result.claimable, false); assert.equal(result.claimSupported, false);
    assert.equal(result.credited, null); assert.equal(result.nextReward, null);
    assert.ok(!f.calls.some(({ path }) => path === CLAIM || path === LANDING));
  }
  const missingDaily = dailyDetail(false); delete missingDaily.tasks[0].daily_checkin;
  const duplicate = dailyDetail(false); duplicate.tasks.push(structuredClone(duplicate.tasks[0]));
  const conflicting = dailyDetail(false); conflicting.tasks.push({ campaign_code: 'different', task_kind: 'daily_signin' });
  const wrongGroup = dailyDetail(false); wrongGroup.tasks[0].campaign_group_code = 'another_campaign';
  const wrongDetail = dailyDetail(false); wrongDetail.campaign_code = 'another_campaign';
  const inconsistent = dailyDetail(false); inconsistent.tasks[0].task_kind = 'different';
  for (const detail of [{}, { tasks: [] }, { ...dailyDetail(false), tasks: {} }, missingDaily, duplicate, conflicting, wrongGroup, wrongDetail, inconsistent]) {
    const f = fixture({ scene: V3_SCENE, detail });
    const status = await f.adapter.checkin({ action: 'claim' });
    assert.equal(status.done, null); assert.equal(status.claimable, false); assert.equal(status.claimSupported, false);
    assert.ok(!f.calls.some(({ path }) => path === CLAIM || path === LANDING));
  }
});
await test('V3 only accepts a finite native quota-grant reward', async () => {
  for (const reward of [null, {}, { reward_type: 'video_credit', reward_amount: 400 },
    { reward_type: 'quota_grant', reward_amount: '400' }, { reward_type: 'quota_grant', reward_amount: -1 },
    { reward_type: 'quota_grant', reward_amount: Infinity }]) {
    const detail = dailyDetail(false); detail.tasks[0].daily_checkin.reward = reward;
    const status = await fixture({ scene: V3_SCENE, detail }).adapter.checkin();
    assert.equal(status.done, false); assert.equal(status.claimable, true);
    assert.equal(status.nextReward, null); assert.equal(status.credited, null);
  }
});
await test('V3 failed claim stays failed even when the legacy popup says complete', async () => {
  const f = fixture({ scene: V3_SCENE, chosen: 2, throwBefore: true });
  await assert.rejects(f.adapter.checkin({ action: 'claim' }), /fixture write failed/);
  const status = await f.adapter.checkin();
  assert.equal(status.done, false); assert.equal(status.claimable, true); assert.equal(status.credited, null);
  assert.equal(status.claimed, undefined); assert.equal(f.calls.filter(({ path }) => path === CLAIM).length, 1);
  assert.deepEqual(f.calls.find(({ path }) => path === CLAIM).body, { scene: V3_SCENE });
  assert.ok(!f.calls.some(({ path }) => path === LANDING));
});
await test('V3 unchecked claim response cannot become a completed daily task', async () => {
  const f = fixture({ scene: V3_SCENE, checkedIn: false, chosen: 2, reward: 3 });
  await assert.rejects(f.adapter.checkin({ action: 'claim' }), /未得到上游确认/);
  assert.equal((await f.adapter.checkin()).done, false);
});
await test('V3 disconnect recovery requires daily confirmation and never awards from the offer', async () => {
  const f = fixture({ scene: V3_SCENE, throwAfter: true });
  const result = await f.adapter.checkin({ action: 'claim' });
  assert.equal(result.done, true); assert.equal(result.recovered, true); assert.equal(result.credited, null);
  assert.equal(result.claimed, undefined);
  await f.adapter.checkin({ action: 'claim' });
  assert.equal(f.calls.filter(({ path }) => path === CLAIM).length, 1);
});
await test('V3 confirmed claim keeps pending delivery separate and survives stale daily data', async () => {
  const f = fixture({ scene: V3_SCENE, reward: 1, detail: dailyDetail(false) });
  const result = await f.adapter.checkin({ action: 'claim' });
  assert.equal(result.done, true); assert.equal(result.credited, null); assert.equal(result.rewardStatus, 'pending');
  assert.equal(result.claimed, undefined);
  const later = await f.adapter.checkin({ action: 'claim' });
  assert.equal(later.done, true); assert.equal(later.already, true);
  assert.equal(f.calls.filter(({ path }) => path === CLAIM).length, 1);
});
await test('V3 authoritative completion cache stays within its account, day and campaign', async () => {
  const f = fixture({ scene: V3_SCENE, detail: dailyDetail(true) });
  assert.equal((await f.adapter.checkin()).done, true);
  f.state.detail = dailyDetail(false);
  assert.equal((await f.adapter.checkin({ action: 'claim' })).done, true);
  assert.ok(!f.calls.some(({ path }) => path === CLAIM));
  f.setAccount('b'.repeat(64));
  assert.equal((await f.adapter.checkin()).done, false);
  f.setAccount('a'.repeat(64)); f.setTime(initialTime + 24 * 60 * 60 * 1000);
  assert.equal((await f.adapter.checkin()).done, false);
  f.setTime(initialTime); f.state.scene = 'another_campaign';
  assert.equal((await f.adapter.checkin()).done, false);
});
await test('legacy popup completion does not seed a confirmed daily cache', async () => {
  const f = fixture({ chosen: 2 });
  assert.equal((await f.adapter.checkin()).done, true);
  f.state.chosen = 1;
  assert.equal((await f.adapter.checkin()).done, false);
});
await test('V3 automatic scheduler preserves a native claim failure for the next run', async () => {
  const f = fixture({ scene: V3_SCENE, throwBefore: true, chosen: 2 });
  const scheduler = createAutoCheckin({ enabled: true, now: () => initialTime,
    getProviders: () => [{ name: 'doubao', accountKey: 'fixture-doubao', adapter: f.adapter }] });
  const first = await scheduler.run();
  assert.equal(first.providers.doubao.done, false); assert.equal(first.providers.doubao.phase, 'error');
  assert.match(first.providers.doubao.lastError, /fixture write failed/);
  assert.equal(first.providers.doubao.lastSuccessAt, null);
  f.state.throwBefore = false;
  const next = await scheduler.run();
  assert.equal(next.providers.doubao.done, true); assert.equal(next.providers.doubao.phase, 'signed');
  assert.equal(f.calls.filter(({ path }) => path === CLAIM).length, 2);
});

console.log(`\n${passed} Doubao account fixture groups passed (offline; real claims: 0)`);
