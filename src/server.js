import http from 'node:http';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { config } from './config.js';
import { traeAdapter } from './adapters/trae.js';
import { soloAdapter } from './adapters/solo.js';
import { qoderAdapter } from './adapters/qoder.js';
import { qoderIntlAdapter } from './adapters/qoder-intl.js';
import { workbuddyAdapter } from './adapters/workbuddy.js';
import { workbuddyConfig } from './workbuddy-config.js';
import { minimaxCodeAdapter } from './adapters/minimax-code.js';
import { minimaxCodeConfig } from './minimax-code-auth.js';
import { minimaxQuota, minimaxCheckin } from './minimax-account.js';
import { doubaoAdapter } from './adapters/doubao.js';
import { openaiAdapter } from './adapters/openai.js';
import { ToolCallAssembler, toolNames } from './toolcall.js';
import { RequestTiming } from './timing.js';
import { createAutoCheckin } from './auto-checkin.js';
import { CompletionState, completionErrorDetails } from './completion.js';
import { captureFailedRequest } from './failure-capture.js';
import { createUsageLedger, creditObservation } from './usage-periods.js';

const sourceRoot = join(config.rootDir, 'src');
const buildHasher = createHash('sha256');
for (const file of readdirSync(sourceRoot, { recursive: true }).filter((file) => file.endsWith('.js')).sort()) {
  buildHasher.update(file).update(readFileSync(join(sourceRoot, file)));
}
const BUILD = buildHasher.digest('hex').slice(0, 12);
const STARTED_AT = new Date().toISOString();

// 独立进程（无控制台）启动时看不到 stdout，所以同时写一份日志文件
const logFile = createWriteStream(join(config.rootDir, 'gateway.log'), { flags: 'a' });
function log(line) {
  const s = `[${new Date().toTimeString().slice(0, 8)}] ${line}`;
  console.log(s);
  logFile.write(s + '\n');
}

const usageLedger = createUsageLedger({
  stateFile: process.env.GATEWAY_USAGE_STATE_FILE || join(config.rootDir, '.workbuddy', 'usage-periods-state.json'),
  log,
});
const pendingQuotas = new Map();

function quotaWithUsage(adapter) {
  if (!pendingQuotas.has(adapter.quota)) {
    const pending = Promise.resolve().then(() => adapter.quota()).then(async (quota) => {
      if (!quota) return quota;
      const { [creditObservation]: observation, ...visible } = quota;
      const usagePeriods = usageLedger.observe(observation);
      await usageLedger.flush();
      return { ...visible, usagePeriods };
    }).finally(() => pendingQuotas.delete(adapter.quota));
    pendingQuotas.set(adapter.quota, pending);
  }
  return pendingQuotas.get(adapter.quota);
}

const minimaxAdapter = {
  ...minimaxCodeAdapter,
  quota: () => minimaxQuota(minimaxCodeConfig),
  checkin: (opts) => minimaxCheckin(opts, minimaxCodeConfig),
};
const ADAPTERS = {
  trae: traeAdapter,
  solo: soloAdapter,
  qoder: qoderAdapter,
  'qoder-intl': qoderIntlAdapter,
  workbuddy: workbuddyAdapter,
  'minimax-code': minimaxAdapter,
  doubao: doubaoAdapter,
  openai: openaiAdapter,
};
if (!Object.hasOwn(ADAPTERS, config.adapter)) {
  throw new Error(`未知 ADAPTER='${config.adapter}'，可选通道：${Object.keys(ADAPTERS).join(' / ')}`);
}

/**
 * 多 provider 注册表（SOP §1.2）
 * 模型 ID 带 `provider::model` 前缀路由；无前缀 = 默认 provider（ADAPTER 环境变量）。
 * enabled() 决定该通道是否出现在 /v1/models 里。
 */
const PROVIDERS = {
  qoder: { adapter: qoderAdapter, enabled: () => existsSync(config.qoder.workerPath) },
  'qoder-intl': { adapter: qoderIntlAdapter, enabled: () => Boolean(config.qoderIntl.token) && existsSync(config.qoderIntl.workerPath) && qoderIntlAdapter.models().length > 0 },
  workbuddy: { adapter: workbuddyAdapter, enabled: () => workbuddyConfig.enabled() && workbuddyAdapter.models().length > 0 },
  'minimax-code': { adapter: minimaxAdapter, enabled: () => minimaxAdapter.enabled() },
  doubao: { adapter: doubaoAdapter, enabled: () => doubaoAdapter.enabled() },
  solo: { adapter: soloAdapter, enabled: () => Boolean(config.trae.token) },
  trae: { adapter: traeAdapter, enabled: () => Boolean(config.trae.token) },
  openai: { adapter: openaiAdapter, enabled: () => Boolean(config.upstream.apiKey) },
};

function enabledProviders() {
  return Object.entries(PROVIDERS)
    .filter(([, p]) => p.enabled())
    .map(([name, p]) => ({ name, adapter: p.adapter }));
}

const autoCheckin = createAutoCheckin({
  getProviders: () => enabledProviders()
    .filter(({ adapter }) => typeof adapter.checkin === 'function')
    .map(({ name, adapter }) => ({ name, adapter,
      accountKey: name === 'solo' || name === 'trae' ? 'trae' : name,
      resetHour: name === 'qoder' || name === 'qoder-intl' ? 10 : 0,
    })),
  stateFile: join(config.rootDir, '.workbuddy', 'auto-checkin-state.json'),
  log,
});

function defaultProvider() {
  return { name: config.adapter, adapter: ADAPTERS[config.adapter] };
}

/** 聚合所有已启用 provider 的模型：[{id:'solo::glm-5__max', display, provider, context?}] */
function allModels() {
  const out = [];
  for (const { name, adapter } of enabledProviders()) {
    for (const m of adapter.models()) {
      if (typeof m === 'string') {
        out.push({ id: `${name}::${m}`, display: m, provider: name });
      } else {
        const entry = { id: `${name}::${m.id}`, display: m.display || m.id, provider: name };
        if (m.context) entry.context = m.context;
        out.push(entry);
      }
    }
  }
  return out;
}

/** 解析 'provider::model' / 裸 'model'（走默认 provider）。不可用返回 null。 */
function resolveModel(raw) {
  let providerName = null;
  let modelName = raw;
  if (typeof raw === 'string' && raw.includes('::')) {
    const i = raw.indexOf('::');
    providerName = raw.slice(0, i);
    modelName = raw.slice(i + 2);
  }
  const entry = providerName
    ? Object.hasOwn(PROVIDERS, providerName)
      ? { name: providerName, adapter: PROVIDERS[providerName].adapter }
      : null
    : defaultProvider();
  if (!entry || !PROVIDERS[entry.name]?.enabled()) return null;
  const names = entry.adapter.models().map((m) => (typeof m === 'string' ? m : m.id));
  if (!names.includes(modelName)) return null;
  return { name: entry.name, adapter: entry.adapter, model: modelName };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function oaError(res, status, message, type = 'upstream_error', details = {}) {
  log(`  ! ${status} ${message}`);
  json(res, status, { error: { message, type, code: status, ...details } });
}

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = normalize(join(config.rootDir, 'public', rel));
  if (!full.startsWith(join(config.rootDir, 'public'))) {
    return oaError(res, 403, 'forbidden', 'invalid_request_error');
  }
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    const buf = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': extname(full) === '.html' ? 'no-store, must-revalidate' : 'public, max-age=3600',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}

async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function authorized(req) {
  if (!config.gatewayKey) return true;
  return (req.headers.authorization || '') === `Bearer ${config.gatewayKey}`;
}

function chunk(id, model, delta, finishReason = null) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/**
 * 适配器给的 toolCall 增量 -> OpenAI 的 delta.tool_calls 形态。
 * id / type / name 只在首帧带，后续帧只带 arguments 增量（和官方语义一致）。
 */
function toolCallDelta(tc) {
  const out = { index: Number.isInteger(tc.index) ? tc.index : 0 };
  if (tc.id) out.id = tc.id;
  if (tc.id || tc.type) out.type = tc.type || 'function';
  const fn = {};
  if (tc.name) fn.name = tc.name;
  fn.arguments = typeof tc.arguments === 'string' ? tc.arguments : '';
  out.function = fn;
  return out;
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const rawModel = body.model || allModels()[0]?.id;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  // OpenAI 规范：不传 stream 就是非流式。之前写成 !== false 会把默认请求也变成 SSE。
  const stream = body.stream === true;
  // tools / tool_choice / 旧版 functions 全部往下传，由适配器决定用原生还是文本协议
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const legacyFunctions = Array.isArray(body.functions) ? body.functions : [];
  const legacyChoice = body.function_call;
  const toolChoice = body.tool_choice ?? (typeof legacyChoice?.name === 'string'
    ? { type: 'function', function: { name: legacyChoice.name } } : legacyChoice ?? null);
  const requestedNames = new Set(toolNames(tools, legacyFunctions));
  const selectedName = toolChoice?.function?.name;
  const requiresTool = typeof selectedName === 'string' || toolChoice === 'required' || toolChoice === 'any';
  const toolCount = tools.length + legacyFunctions.length;
  log(`  model=${rawModel} msgs=${messages.length} stream=${stream} tools=${toolCount}`);
  if (!messages.length) return oaError(res, 400, 'messages is required', 'invalid_request_error');
  if (!rawModel) return oaError(res, 503, '暂无已启用的模型，请先配置并登录需要使用的通道', 'service_unavailable_error');
  if (typeof rawModel === 'string' && !rawModel.includes('::') && !PROVIDERS[config.adapter].enabled()) {
    return oaError(res, 400, `默认通道 ${config.adapter} 未启用，请检查该通道登录或使用 /v1/models 中的完整模型 ID`, 'authentication_error');
  }
  if (requiresTool && (!requestedNames.size || (typeof selectedName === 'string' && !requestedNames.has(selectedName)))) {
    return oaError(res, 400, 'tool_choice 必须引用已声明的工具', 'invalid_request_error');
  }

  const resolved = resolveModel(rawModel);
  if (!resolved) {
    return oaError(
      res,
      404,
      `unknown model '${rawModel}'. available: ${allModels().map((m) => m.id).join(', ')}`,
      'invalid_request_error',
    );
  }
  const { adapter, model, name: providerName } = resolved;
  if ((providerName === 'trae' || providerName === 'solo') && !config.trae.token) {
    return oaError(res, 400, '上游 token 未配置，请先在设置里填入 Trae token', 'authentication_error');
  }
  if (adapter.name === 'openai' && !config.upstream.apiKey) {
    return oaError(
      res,
      400,
      '未配置上游密钥：启动时加 UPSTREAM_KEY=xxx UPSTREAM_BASE=https://... 即可',
      'authentication_error',
    );
  }

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const ac = new AbortController();
  // 注意：Node 16+ 的 req 'close' 在请求体读完后就会触发，挂在这里会立刻 abort 上游。
  // 只有响应连接异常中断（客户端真的走了）时才需要取消上游请求。
  res.on('close', () => {
    if (!res.writableEnded) ac.abort();
  });

  const timing = new RequestTiming({ provider: providerName, tools: toolCount, requestBytes: Buffer.byteLength(JSON.stringify(body)) });
  const completion = new CompletionState();
  const upstream = adapter.stream({
    model,
    messages,
    temperature: body.temperature,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
    signal: ac.signal,
    tools,
    functions: legacyFunctions,
    toolChoice,
  });
  const consume = (async function* () {
    let chargeRecorded = false;
    const toolIndexes = new Map();
    try {
      for await (let event of upstream) {
        if (event.toolCall) {
          const call = event.toolCall;
          if (toolChoice === 'none' || (call.name && ((selectedName && call.name !== selectedName)
            || (requestedNames.size && !requestedNames.has(call.name))))) {
            completion.reject('upstream_unknown_tool', '上游返回了本轮未允许的工具调用');
          }
          const index = Number.isInteger(call.index) ? call.index : 0;
          if (!toolIndexes.has(index)) toolIndexes.set(index, toolIndexes.size);
          event = { ...event, toolCall: { ...call, index: toolIndexes.get(index) } };
        }
        timing.observe(event);
        completion.observe(event);
        if (event.creditCharge && !chargeRecorded) {
          usageLedger.charge(event.creditCharge);
          chargeRecorded = true;
        }
        yield event;
      }
      ac.signal.throwIfAborted();
      completion.complete();
    } catch (error) {
      completion.fail(error, ac.signal.aborted);
      if (!ac.signal.aborted) {
        const capture = await captureFailedRequest({ root: config.rootDir, id, body, completion, error });
        if (capture.captured) log(`  diagnostic id=${id} encrypted_capture=${capture.path} ${JSON.stringify(capture.summary)}`);
        else if (capture.reason !== 'disabled' && capture.reason !== 'not_reasoning_only') {
          log(`  diagnostic id=${id} capture_skipped=${capture.reason}${capture.errorCode ? ` code=${capture.errorCode}` : ''}`);
        }
      }
      throw error;
    } finally {
      if (chargeRecorded) await usageLedger.flush();
      log(`  timing id=${id} model=${rawModel} ${JSON.stringify(timing.snapshot())}`);
      log(`  completion id=${id} model=${rawModel} ${JSON.stringify(completion.snapshot())}`);
    }
  })();

  if (!stream) {
    let text = '';
    let reasoning = '';
    let usage = null;
    const calls = new ToolCallAssembler();
    try {
      for await (const d of consume) {
        if (d.reasoning) reasoning += d.reasoning;
        if (d.text) text += d.text;
        if (d.toolCall) calls.push(d.toolCall);
        if (d.usage) usage = d.usage;
      }
    } catch (err) {
      if (res.destroyed) return;
      if (!res.headersSent) return oaError(res, Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 502, String(err.message || err), err.type || 'upstream_error', completionErrorDetails(err, completion));
      return res.end();
    }
    const toolCalls = calls.toOpenAI(id);
    const message = { role: 'assistant', content: text };
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (reasoning) message.reasoning_content = reasoning;
    return json(res, 200, {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: rawModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: completion.finishReason,
        },
      ],
      ...(usage && completion.usageComplete ? { usage } : {}),
      gateway_timing: timing.snapshot(),
      gateway_completion: completion.snapshot(),
    });
  }

  let bytes = 0;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (obj) => {
    const s = `data: ${JSON.stringify(obj)}\n\n`;
    bytes += Buffer.byteLength(s);
    res.write(s);
  };
  // Flush immediately: waiting/CLI startup must not look like a hung connection.
  res.flushHeaders();
  send(chunk(id, rawModel, { role: 'assistant' }));

  try {
    let usage = null;
    let sawToolCall = false;
    const seenToolIdx = new Set();
    for await (const d of consume) {
      // solo 通道会排队，把进度用扩展字段下发；不污染 content / reasoning_content
      if (d.status) {
        send({ ...chunk(id, rawModel, {}), gateway_status: d.status });
        log(`  ${d.status}`);
        continue;
      }
      if (d.toolCall) {
        sawToolCall = true;
        // 部分通道（trae/qoder 的文本兜底）没有 id，官方 SDK 需要首帧带 id
        const idx = Number.isInteger(d.toolCall.index) ? d.toolCall.index : 0;
        if (!d.toolCall.id && !seenToolIdx.has(idx)) {
          d.toolCall.id = `call_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        }
        seenToolIdx.add(idx);
        send(chunk(id, rawModel, { tool_calls: [toolCallDelta(d.toolCall)] }));
      }
      if (d.reasoning) send(chunk(id, rawModel, { reasoning_content: d.reasoning }));
      if (d.text) send(chunk(id, rawModel, { content: d.text }));
      if (d.usage) usage = d.usage;
    }
    send({
      ...chunk(id, rawModel, {}, completion.finishReason),
      ...(usage && completion.usageComplete ? { usage } : {}),
      gateway_timing: timing.snapshot(),
      gateway_completion: completion.snapshot(),
    });
    res.write('data: [DONE]\n\n');
    res.end();
    log(`  流出 ${bytes}B 已发给浏览器${sawToolCall ? '（含 tool_calls）' : ''}`);
  } catch (err) {
    if (!res.writableEnded && !res.destroyed) {
      send({ error: { message: String(err.message || err), type: err.type || 'upstream_error', code: err.status || 502, ...completionErrorDetails(err, completion) },
        gateway_timing: timing.snapshot(), gateway_completion: completion.snapshot() });
      res.write('data: [DONE]\n\n');
      res.end();
    }
    log(`  流出中断 ${bytes}B ${err.message || err}`);
  }
}

// 监听 0.0.0.0 = 局域网内任何设备都能直接用，不需要密钥。
// 想加一道锁的话启动时设 GATEWAY_KEY，此时访问方要在「设置 → 网关密钥」里填同一串。
const listensOnAll = config.host === '0.0.0.0' || config.host === '::';

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  return out;
}

if (listensOnAll && !config.gatewayKey) {
  log('  免密模式：局域网内任何设备都能直接调用（要加锁就设 GATEWAY_KEY）');
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const t0 = Date.now();
  res.on('finish', () => {
    // 静态资源太吵，只记接口调用
    if (!path.startsWith('/v1/') && path !== '/health') return;
    log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms`);
  });

  if (req.method === 'GET' && path === '/health') {
    // 无鉴权：让局域网里的设备在还没填密钥时也能探到网关活着、也知道地址
    return json(res, 200, {
      ok: true,
      adapter: config.adapter,
      providers: enabledProviders().map((p) => p.name),
      models: allModels().length,
      host: config.host,
      lan: listensOnAll ? lanAddresses() : [],
      gatewayKeyRequired: Boolean(config.gatewayKey),
    });
  }

  if (req.method === 'GET' && !path.startsWith('/v1/')) {
    return serveStatic(res, path);
  }

  if (!authorized(req)) {
    return oaError(res, 401, '网关密钥无效（在设置里填写）', 'authentication_error');
  }

  try {
    if (req.method === 'GET' && path === '/v1/status') {
      return json(res, 200, {
        build: BUILD,
        pid: process.pid,
        startedAt: STARTED_AT,
        automation: autoCheckin.status(),
        adapter: config.adapter,
        defaultProvider: defaultProvider().name,
        providers: enabledProviders().map(({ name, adapter }) => ({
          name,
          modelCount: adapter.models().length,
          hasQuota: typeof adapter.quota === 'function',
          supportsTools: Boolean(adapter.supportsTools),
        })),
        hasToken: Boolean(config.trae.token),
        hasUpstreamKey: Boolean(config.upstream.apiKey),
        upstreamBase: config.upstream.baseUrl || '',
        gatewayKeyRequired: Boolean(config.gatewayKey),
        host: config.host,
        lan: listensOnAll ? lanAddresses() : [],
        // 前端 renderModels 依赖对象结构 {id,display,provider,context}
        models: allModels(),
      });
    }

    if (req.method === 'POST' && path === '/v1/token') {
      if (!PROVIDERS.trae.enabled() && !PROVIDERS.solo.enabled() && config.adapter !== 'trae' && config.adapter !== 'solo') {
        return oaError(res, 400, '当前没有需要 token 的通道', 'invalid_request_error');
      }
      const body = await readBody(req, 65536);
      const token = String(body.token || '').trim();
      if (!token) return oaError(res, 400, 'token 不能为空', 'invalid_request_error');
      config.trae.token = token.replace(/^(?:Bearer|Cloud-IDE-JWT)\s+/i, '');
      config.trae.headers.authorization = `Cloud-IDE-JWT ${config.trae.token}`;
      config.trae.headers['x-ide-token'] = config.trae.token;
      return json(res, 200, { ok: true, hasToken: true });
    }

    if (req.method === 'GET' && path === '/v1/models') {
      const list = allModels();
      return json(res, 200, {
        object: 'list',
        data: list.map((m) => ({
          id: m.id,
          object: 'model',
          created: 0,
          owned_by: m.provider,
          display_name: m.display,
          ...(m.context ? { context_window: m.context } : {}),
        })),
      });
    }

    if (req.method === 'GET' && path === '/v1/quota') {
      // 聚合各 provider 的积分/权益；单点失败不影响其它，失败项返回 {error}
      // ?provider=qoder 只查单个（SOP §1.3）
      const only = url.searchParams.get('provider');
      const out = {};
      await Promise.all(
        enabledProviders()
          .filter(({ name }) => !only || name === only)
          .map(async ({ name, adapter }) => {
            if (typeof adapter.quota !== 'function') {
              out[name] = null;
              return;
            }
            try {
              // trae / solo share one account and the same quota implementation.
              out[name] = await quotaWithUsage(adapter);
            } catch (e) {
              out[name] = { error: String(e.message || e) };
            }
          }),
      );
      return json(res, 200, { providers: out, automation: autoCheckin.status(), fetchedAt: new Date().toISOString() });
    }

    if (req.method === 'GET' && path === '/v1/checkin') {
      // 只读：当前能领什么、领没领（写操作走 POST）
      const only = url.searchParams.get('provider');
      const out = {};
      const pending = new Map();
      await Promise.all(
        enabledProviders()
          .filter(({ name }) => !only || name === only)
          .map(async ({ name, adapter }) => {
            if (typeof adapter.checkin !== 'function') {
              out[name] = null;
              return;
            }
            try {
              if (!pending.has(adapter.checkin)) pending.set(adapter.checkin, Promise.resolve().then(() => adapter.checkin({})));
              out[name] = await pending.get(adapter.checkin);
            } catch (e) {
              out[name] = { error: String(e.message || e) };
            }
          }),
      );
      return json(res, 200, { providers: out, automation: autoCheckin.status(), fetchedAt: new Date().toISOString() });
    }

    if (req.method === 'POST' && path === '/v1/checkin') {
      const b = await readBody(req, 4096);
      const provider = String(b.provider || '');
      const p = PROVIDERS[provider];
      if (!p || !p.enabled()) return oaError(res, 404, `未知或未启用的 provider: '${provider}'`, 'invalid_request_error');
      if (provider === 'minimax-code' && b.action === 'claim' && !config.gatewayKey) {
        return oaError(res, 403, 'MiniMax Code 手动领取需要启用网关密钥，后台自动签到可用', 'permission_error');
      }
      if (typeof p.adapter.checkin !== 'function') {
        return oaError(res, 501, `${provider} 没有签到机制或尚未实现`, 'not_implemented');
      }
      try {
        return json(res, 200, await p.adapter.checkin(b));
      } catch (e) {
        return oaError(res, 502, String(e.message || e));
      }
    }

    if (req.method === 'POST' && path === '/v1/report') {
      // 浏览器端的自述：加载了哪个版本、请求成败、报错原文。排查"没回复"用。
      const b = await readBody(req, 65536);
      log(`  客户端 ${JSON.stringify(b).slice(0, 500)}`);
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/v1/chat/completions') {
      return await handleChat(req, res);
    }

    return oaError(res, 404, `no route for ${req.method} ${path}`, 'invalid_request_error');
  } catch (err) {
    if (!res.headersSent) oaError(res, 500, String(err.message || err));
    else res.end();
  }
});

server.listen(config.port, config.host, () => {
  const lan = lanAddresses();
  log(`trae-gateway  pid=${process.pid}  监听 ${config.host}:${config.port}`);
  log(`  本机       : http://127.0.0.1:${config.port}`);
  if (listensOnAll) {
    for (const n of lan) log(`  局域网(${n.name}) : http://${n.address}:${config.port}`);
    if (!lan.length) log('  局域网     : 没找到非回环 IPv4 地址，检查一下网卡');
    log('  提醒       : Windows 首次可能拦防火墙，需放行该端口的入站 TCP');
  }
  log(`  默认通道: ${defaultProvider().name}（模型 ID 可用 provider::model 前缀跨通道调用）`);
  for (const { name, adapter } of enabledProviders()) {
    log(`  通道    : ${name.padEnd(10)} ${adapter.models().length} 个模型${typeof adapter.quota === 'function' ? '  [积分可查]' : ''}`);
  }
  log(`  密钥   : ${config.gatewayKey ? '已启用' : '未启用'}`);
  autoCheckin.start();
});

server.once('close', () => autoCheckin.stop());
