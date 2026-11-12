import { spawn, execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { workbuddyConfig } from '../workbuddy-config.js';
import { buildWorkbuddyCatalog, resolveWorkbuddyProduct } from '../workbuddy-models.js';
import { formatReasoningHistory, toolsToPromptText, toolNames, ToolMarkupSieve } from '../toolcall.js';
import { creditObservation } from '../usage-periods.js';
import { isHarnessCompaction } from '../harness-compaction.js';

const textOf = (v) => typeof v === 'string' ? v : Array.isArray(v) ? v.map((x) => x?.text || '').join('\n') : '';
export function toWorkbuddyPrompt(messages, toolPrompt = '') {
  const list = Array.isArray(messages) ? messages : [];
  const callNames = new Map();
  const callText = (c) => {
    const fn = c.function || c.function_call || {};
    let args = fn.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { /* Preserve non-JSON arguments as text. */ }
    }
    const data = { ...(c.id != null ? { id: c.id } : {}), name: fn.name || '', arguments: args === undefined ? {} : args };
    return `<tool_call>${JSON.stringify(data).replace(/</g, '\\u003c')}</tool_call>`;
  };
  return [toolPrompt, ...list.map((m) => {
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
    const reasoning = m.role === 'assistant' ? formatReasoningHistory(m) : '';
    const body = [reasoning, textOf(m.content), ...calls.map(callText)].filter(Boolean).join('\n');
    if (m.role === 'tool' || m.role === 'function') {
      const name = m.name || callNames.get(m.tool_call_id);
      const labels = [name ? `name=${JSON.stringify(name)}` : '', m.tool_call_id != null ? `id=${JSON.stringify(m.tool_call_id)}` : ''].filter(Boolean).join(' ');
      return `[${m.role}${labels ? ` ${labels}` : ''}]\n${body}`;
    }
    if (m.role === 'assistant') {
      for (const call of calls) {
        if (call.id != null) callNames.set(call.id, (call.function || call.function_call || {}).name || '');
      }
    }
    return `[${m.role}]\n${body}`;
  })].filter(Boolean).join('\n\n');
}

export function workbuddyCliEnv(cfg = workbuddyConfig) {
  const env = { ...process.env,
    ELECTRON_RUN_AS_NODE: '1', WORKBUDDY_INSTALL_DIR: cfg.installDir,
    WORKBUDDY_CLI_PATH: cfg.cliPath, WORKBUDDY_AUTH_FILE: cfg.authFile,
    WORKBUDDY_CONFIG_DIR: cfg.configDir, CODEBUDDY_CONFIG_DIR: cfg.configDir,
    CODEBUDDY_DISABLE_IDE: '1', DISABLE_TELEMETRY: '1',
    CODEBUDDY_HOST: 'workbuddy-desktop', CODEBUDDY_DISABLE_PLAN_MODE: '1', CODEBUDDY_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
  };
  if (cfg.cachedProduct()) env.ACC_PRODUCT_CONFIG_PATH = cfg.productFile;
  else delete env.ACC_PRODUCT_CONFIG_PATH;
  // Do not inherit another managed WorkBuddy run's private IPC identity.
  for (const k of Object.keys(env)) if (k.startsWith('CODEBUDDY_SIDECAR_') || k === 'CODEBUDDY_RUNTIME_INSTANCE_ID' || k === 'WORKBUDDY_AT_REST_ENCRYPTION') delete env[k];
  return env;
}

export function workbuddyCliArgs(model, cfg = workbuddyConfig) {
  const instructions = 'Answer the supplied conversation. The gateway section [可用工具] declares external tools. '
    + 'Request a declared tool by outputting the specified JSON tool_calls object. '
    + 'The API caller executes the request and sends actual results in a later [tool] message. '
    + 'Wait for those results. Never execute local tools or business actions or invent tool results.';
  const agents = { minimal: { description: 'Dialogue and external tool requests', prompt: instructions, tools: [] } };
  return [cfg.wrapperPath, '-p', '--input-format', 'text', '--model', model,
    '--output-format', 'stream-json', '--include-partial-messages', '--no-session-persistence',
    '--tools', '', '--disallowedTools', '*', '--permission-mode', 'dontAsk', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '', '--settings', '{"hooks":{},"enabledPlugins":{}}',
    '--agent', 'minimal', '--agents', JSON.stringify(agents),
    '--max-turns', '1', '--system-prompt', instructions];
}

export function normalizeWorkbuddyUsage(u, modelUsage) {
  if (!u || !Number.isFinite(Number(u.input_tokens)) || !Number.isFinite(Number(u.output_tokens))) return null;
  // CLI result.usage.input_tokens already includes its cache buckets (verified
  // against result.modelUsage). Prefer the disjoint per-model counters when
  // present; never add the cache buckets to the inclusive result total twice.
  const perModel = Object.values(modelUsage || {});
  const cached = Number(u.cache_read_input_tokens) || 0;
  const prompt = perModel.length ? perModel.reduce((n, m) => n + (Number(m.inputTokens) || 0) + (Number(m.cacheReadInputTokens) || 0) + (Number(m.cacheCreationInputTokens) || 0), 0)
    : Math.max(Number(u.input_tokens), cached + (Number(u.cache_creation_input_tokens) || 0));
  const completion = Number(u.output_tokens);
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
    ...(u.cache_read_input_tokens != null ? { prompt_tokens_details: { cached_tokens: Math.min(prompt, cached) } } : {}) };
}

export const sanitizeWorkbuddyError = (s) => String(s || '').replace(/(Bearer\s+)\S+/gi, '$1[redacted]').replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]');

export async function* streamWorkbuddy({ model, messages, tools, functions, toolChoice, signal }) {
  const cfg = workbuddyConfig;
  if (!cfg.enabled()) throw Object.assign(new Error('WorkBuddy client or login is missing; open WorkBuddy and sign in.'), { status: 400, type: 'authentication_error' });
  if (signal?.aborted) throw signal.reason || new Error('Aborted');
  const compaction = isHarnessCompaction(messages, toolChoice);
  const names = toolChoice === 'none' || compaction ? [] : toolNames(tools, functions);
  const forced = typeof toolChoice === 'object' && toolChoice?.function?.name;
  const requiresTool = Boolean(forced) || toolChoice === 'required' || toolChoice === 'any';
  if (requiresTool && (!names.length || forced && !names.includes(forced))) {
    throw Object.assign(new Error('WorkBuddy tool_choice 必须引用已声明的工具'), { status: 400, type: 'invalid_request_error' });
  }
  mkdirSync(cfg.cwd, { recursive: true });
  const started = performance.now();
  const prompt = toWorkbuddyPrompt(messages, toolsToPromptText(tools, functions, toolChoice, { format: 'json' }));
  const child = spawn(cfg.exePath, workbuddyCliArgs(model), {
    cwd: cfg.cwd, env: workbuddyCliEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let childError = null, stdinError = null, exitCode = null, timedOut = false, result = null, first = true;
  let emittedText = false, toolIndex = 0, stderr = '', upstreamFinishReason;
  const sieve = new ToolMarkupSieve({ allowedNames: forced ? [forced] : names, tools, functions,
    allowFencedToolCalls: names.length > 0, strictAfterCalls: true });
  const blocks = new Map();
  const unindexedPartials = new Set();
  const rawTextParts = [];
  const guardedDone = { done: true, finishReason: 'tool_calls', terminationReason: 'tool_turn_boundary' };
  function* emitFiltered(filtered) {
    if (filtered.text) yield { text: filtered.text };
    for (const call of filtered.calls) {
      yield { toolCall: { index: toolIndex++, id: call.id, name: call.name, arguments: call.arguments } };
    }
  }
  function* emitBlock(kind, value) {
    if (typeof value !== 'string' || !value) return;
    if (kind === 'thinking') yield { reasoning: value };
    if (kind === 'text') {
      emittedText = true;
      rawTextParts.push(value);
      yield* emitFiltered(sieve.push(value));
    }
  }
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, cfg.timeoutMs);
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  const closed = new Promise((resolve) => {
    child.once('error', (e) => { childError = e; resolve(); });
    child.once('close', (code) => { exitCode = code; resolve(); });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s) => { if (stderr.length < 2000) stderr += s; });
  child.stdin.on('error', (error) => {
    stdinError = error;
    child.kill();
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    // The official text input reads stdin through EOF. Avoid Windows argv limits
    // and keep the complete conversation/tool prompt out of process arguments.
    child.stdin.end(prompt, 'utf8');
    for await (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (first) { first = false; yield { timing: { cli_first_event_ms: Math.round(performance.now() - started) },
        ...(compaction ? { requestPurpose: 'compaction' } : {}) }; }
      if (e.type === 'stream_event') {
        const { delta, index } = e.event || {};
        if (typeof delta?.stop_reason === 'string') upstreamFinishReason = delta.stop_reason;
        const kind = delta?.type === 'thinking_delta' ? 'thinking' : delta?.type === 'text_delta' ? 'text' : null;
        const value = kind && delta[kind];
        if (typeof value === 'string' && value) {
          if (Number.isInteger(index)) {
            const key = `${kind}/${index}`;
            blocks.set(key, (blocks.get(key) || '') + value);
          } else unindexedPartials.add(kind);
          yield* emitBlock(kind, value);
          if (sieve.stopped) { yield guardedDone; return; }
        }
      } else if (e.type === 'assistant') {
        if (typeof e.message?.stop_reason === 'string') upstreamFinishReason = e.message.stop_reason;
        const content = Array.isArray(e.message?.content) ? e.message.content : [];
        if (unindexedPartials.has('text')) {
          const snapshot = content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('');
          const prefix = rawTextParts.join('');
          // Unindexed deltas still have an exact raw prefix. A complete snapshot
          // may supply the JSON/fence tail; append only bytes that actually agree.
          if (snapshot.startsWith(prefix)) {
            yield* emitBlock('text', snapshot.slice(prefix.length));
            if (sieve.stopped) { yield guardedDone; return; }
          }
        }
        for (const [index, block] of content.entries()) {
          const kind = block?.type;
          if ((kind !== 'thinking' && kind !== 'text') || unindexedPartials.has(kind)) continue;
          const value = block[kind];
          const key = `${kind}/${index}`;
          const seen = blocks.get(key);
          // The full assistant block can repeat deltas or fill their missing suffix.
          if (typeof value !== 'string' || (seen !== undefined && !value.startsWith(seen))) continue;
          // A singleton snapshot can omit earlier block types and renumber its one block.
          if (seen === undefined && content.length === 1
            && [...blocks].some(([blockKey, streamed]) => blockKey.startsWith(`${kind}/`) && streamed === value)) continue;
          if (seen !== undefined) blocks.set(key, value);
          yield* emitBlock(kind, value.slice(seen?.length ?? 0));
          if (sieve.stopped) { yield guardedDone; return; }
        }
      } else if (e.type === 'result') { result = e; }
    }
    await closed;
    if (signal?.aborted) throw signal.reason || new Error('Aborted');
    if (timedOut) throw new Error(`WorkBuddy CLI timed out after ${cfg.timeoutMs}ms`);
    if (childError) throw childError;
    if (stdinError) throw new Error(sanitizeWorkbuddyError(`WorkBuddy CLI stdin failed: ${stdinError.message}${stderr.trim() ? `; ${stderr.trim().slice(0,500)}` : ''}`));
    if (!result || result.is_error || result.subtype !== 'success' || exitCode !== 0) {
      const message = (result?.errors || []).join('; ') || result?.result || `CLI closed without success (exit=${exitCode})`;
      const auth = /authentication|login|unauthori[sz]ed|expired|401/i.test(message)
        || /请先在本机登录 WorkBuddy|无法读取 WorkBuddy 的加密登录/.test(stderr);
      throw Object.assign(new Error(sanitizeWorkbuddyError(`WorkBuddy: ${message}${stderr.trim() ? `; ${stderr.trim().slice(0,500)}` : ''}`)), { status: auth ? 400 : 502, type: auth ? 'authentication_error' : 'upstream_error' });
    }
    if (typeof result.result === 'string' && result.result) {
      const prefix = rawTextParts.join('');
      if (!emittedText || result.result.startsWith(prefix)) {
        yield* emitBlock('text', result.result.slice(prefix.length));
      }
    }
    if (!sieve.stopped) yield* emitFiltered(sieve.flush());
    if (requiresTool && !toolIndex) {
      throw Object.assign(new Error('WorkBuddy 未返回本轮要求的工具调用'), {
        code: 'upstream_missing_tool_call', status: 502, type: 'upstream_error',
      });
    }
    const usage = normalizeWorkbuddyUsage(result.usage, result.modelUsage);
    if (usage) yield { usage };
    yield sieve.stopped ? guardedDone : {
      done: true, upstreamFinishReason: result.stop_reason ?? upstreamFinishReason, terminationReason: 'upstream_done',
    };
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); lines.close();
    if (exitCode === null && !child.killed) child.kill();
  }
}

const execFileAsync = promisify(execFile);
export async function workbuddyQuery(query, { observe = false } = {}) {
  const cfg = workbuddyConfig;
  const observeSummary = observe && query === 'summary';
  const args = [cfg.wrapperPath, '--gateway-query', query];
  if (observeSummary) args.push('--gateway-observation');
  let stdout;
  try {
    ({ stdout } = await execFileAsync(cfg.exePath, args, {
      env: workbuddyCliEnv(), windowsHide: true, timeout: query === 'claim' ? 25000 : 15000, maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    const detail = sanitizeWorkbuddyError(error.stderr).trim().slice(0, 500);
    throw new Error(detail || (error.killed ? 'WorkBuddy 账户请求超时。' : '无法启动 WorkBuddy，请检查客户端安装。'));
  }
  const raw = JSON.parse(stdout.trim());
  // Preserve the official claim business codes for race/already/ineligible handling.
  if (query === 'claim') return raw;
  if (raw.code !== 0 || !raw.data) throw new Error(`WorkBuddy ${query}: ${raw.code} ${sanitizeWorkbuddyError(raw.msg)}`);
  return observeSummary ? { data: raw.data, account: raw.gatewayAccountKey } : raw.data;
}

export function normalizeWorkbuddyCheckin(d = {}) {
  const active = d.active === true;
  const done = active && typeof d.today_checked_in === 'boolean' ? d.today_checked_in : null;
  const claimable = active && done === false;
  return { provider: 'workbuddy', supported: true, active, done, claimable,
    streak: Number(d.streak_days) || 0,
    nextReward: claimable ? { amount: Number(d.daily_credit) || 0, title: d.activity_name || '每日签到' } : null,
    reason: !active ? '当前没有进行中的签到活动' : done === null ? '上游没有返回当日签到状态' : '',
    claimSupported: true };
}

export async function workbuddyCheckin(opts = {}, query = workbuddyQuery) {
  const status = normalizeWorkbuddyCheckin(await query('checkin'));
  if (opts.action !== 'claim') return { ok: true, ...status };
  if (!status.active) return { ok: true, ...status, skipped: true, skipReason: 'inactive' };
  if (status.done) return { ok: true, ...status, already: true, skipped: true, skipReason: 'already' };
  if (!status.claimable) return { ok: false, ...status, skipped: true, skipReason: 'unknown_status', error: status.reason };

  const raw = await query('claim');
  // The wrapper also checks state immediately before the write, closing the gap
  // between the adapter's read and a scheduled/manual claim.
  if (raw.data?.gateway_skipped) {
    const after = normalizeWorkbuddyCheckin(raw.data.checkin);
    return { ok: raw.data.gateway_skipped !== 'unknown_status', ...after, skipped: true,
      already: raw.data.gateway_skipped === 'already', skipReason: raw.data.gateway_skipped };
  }
  const code = raw.code;
  if (code === 1001) return { ok: true, ...status, done: true, claimable: false,
    already: true, skipped: true, code, claimStatus: 'already_claimed' };
  if (code !== 0) {
    const claimStatus = code === 1002 ? 'not_eligible' : code === 1003 ? 'event_ended' : 'unknown_biz_error';
    return { ok: false, ...status, claimable: false, code, claimStatus,
      ...(code === 1002 ? { eligible: false } : {}),
      ...(code === 1003 ? { active: false, done: null } : {}),
      skipped: code === 1002 || code === 1003,
      error: sanitizeWorkbuddyError(raw.msg || 'WorkBuddy checkin failed') };
  }
  const reward = raw.data || {};
  const after = await query('checkin').then(normalizeWorkbuddyCheckin).catch(() => null);
  return { ok: true, ...status, done: true, claimable: false, claimStatus: 'claimed',
    claimed: [{ ok: true, amount: reward.credit ?? null, streak: reward.streak_days ?? null,
      isStreakDay: reward.is_streak_day ?? null }], after };
}

function workbuddyCreditValue(value) {
  const number = typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function workbuddyCreditCounters(groups) {
  const counters = [];
  for (const group of groups) {
    if (typeof group?.Kind !== 'string' || !group.Kind || group.CapacityUnit !== 'credits') continue;
    const capacity = workbuddyCreditValue(group.CycleTotalCapacity);
    const count = workbuddyCreditValue(group.TotalCount);
    const used = workbuddyCreditValue(group.CycleUsedCapacity);
    if (capacity === null || !Number.isSafeInteger(count) || used === null) continue;
    const cycle = Object.keys(group).sort()
      .filter((key) => /^(?:Cycle|Period|Reset|Expire|StartTime|EndTime)/.test(key) && !key.endsWith('Capacity'))
      .map((key) => [key, group[key]]);
    if (cycle.some(([, value]) => value != null && typeof value !== 'string' && !Number.isFinite(value))) continue;
    counters.push([JSON.stringify([group.Kind, capacity, count, group.CapacityUnit, cycle]), used]);
  }
  return counters;
}

export async function workbuddyQuota(query = workbuddyQuery) {
  const [{ data: d, account }, checkin] = await Promise.all([
    query('summary', { observe: true }), workbuddyCheckin({}, query).catch(() => null),
  ]);
  const groups = Array.isArray(d.CreditGroups) ? d.CreditGroups : (d.Packages || []);
  const total = groups.reduce((n, g) => n + (Number(g.CycleTotalCapacity) || 0), 0);
  const used = groups.reduce((n, g) => n + (Number(g.CycleUsedCapacity) || 0), 0);
  const remaining = d.TotalCredits != null ? Number(d.TotalCredits) : groups.reduce((n, g) => n + (Number(g.CycleRemainCapacity) || 0), 0);
  return { provider: 'workbuddy', plan: d.SubscriptionPackageName || '未知套餐', total, used, remaining, quota: remaining,
    ratio: total ? used / total : 0, checkin, packs: groups.map((g) => ({ name: g.Name || g.PackageCode, limit: Number(g.CycleRemainCapacity) || 0 })),
    ...(account && Array.isArray(d.CreditGroups) && { [creditObservation]: { account, method: 'snapshot', counters: workbuddyCreditCounters(groups) } }),
  };
}

let catalogRefreshAfter = 0;
let fetchedModels;

function workbuddyModels() {
  const cfg = workbuddyConfig;
  const cached = cfg.cachedProduct();
  if (cached || !cfg.enabled()) return cfg.models(cached);

  // Fill a cold catalogue without blocking gateway startup or /v1/models.
  if (Date.now() >= catalogRefreshAfter) {
    catalogRefreshAfter = Infinity;
    void workbuddyQuery('catalog').then((remote) => {
      if (!remote.models?.length) throw new Error('Empty WorkBuddy catalogue');
      const models = buildWorkbuddyCatalog(resolveWorkbuddyProduct(cfg.packagedProduct(), remote)).models;
      if (!models.length) throw new Error('No WorkBuddy chat models');
      fetchedModels = models;
      catalogRefreshAfter = Date.now() + 8 * 60_000;
    }).catch(() => { catalogRefreshAfter = Date.now() + 30_000; });
  }
  return fetchedModels?.map((model) => ({ ...model })) || cfg.models(null);
}

export const workbuddyAdapter = {
  name: 'workbuddy', models: workbuddyModels, stream: streamWorkbuddy,
  quota: workbuddyQuota,
  checkin: workbuddyCheckin,
  supportsTools: false,
};
