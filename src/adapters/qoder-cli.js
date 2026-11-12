import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/** Official CLI JSONL transport. Host credentials travel over stdin, never argv or disk. */
export async function* qoderCliEvents(cfg, { model, prompt, maxTokens, signal, purpose = 'chat' } = {}) {
  signal?.throwIfAborted();
  if (typeof prompt === 'string' && prompt.length > 8 * 1024 * 1024) {
    throw Object.assign(new Error('Qoder 请求超过 CLI 的 8 Mi 字符输入上限，请缩短对话或工具定义'), { status: 400, type: 'invalid_request_error' });
  }
  let tempDir;
  let child;
  let timer;
  let terminalError;
  let closed = false;
  let resultSeen = false;
  let exitCode;
  let stderr = '';
  const queue = [];
  let wake;
  const push = (event) => { queue.push(event); wake?.(); };
  const fail = (error) => { terminalError ||= error; wake?.(); };
  const stop = () => { try { child?.kill(); } catch {} };
  const abort = () => { fail(signal.reason instanceof Error ? signal.reason : new Error('Request aborted')); stop(); };
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const args = [cfg.workerPath, '-p'];
    if (model) args.push('--model', model);
    args.push('--output-format', 'stream-json', '--include-partial-messages', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '');
    if (Number.isFinite(maxTokens) && maxTokens > 0) args.push('--max-output-tokens', String(Math.floor(maxTokens)));
    if (cfg.configDir) args.push('--config-dir', cfg.configDir);
    if (cfg.sdkHostToken) {
      if (!cfg.token) throw new Error(`${cfg.provider} token 未配置，请运行 tools/refresh-qoder-intl-auth.mjs`);
      tempDir = await mkdtemp(join(tmpdir(), 'qoder-gateway-'));
      const payload = join(tempDir, 'auth.json');
      await writeFile(payload, '{"type":"jobToken","jobTokenProvider":"host"}', { mode: 0o600 });
      env.QODER_AGENT_SDK_ENTRYPOINT = 'gateway';
      env.QODER_SDK_AUTH_PAYLOAD_FILE = payload;
      args.push('--input-format', 'stream-json');
    } else {
      args.push('--input-format', 'text');
      delete env.QODER_AGENT_SDK_ENTRYPOINT;
      delete env.QODER_SDK_AUTH_PAYLOAD_FILE;
    }
    const start = performance.now();
    child = spawn(cfg.exePath, args, {
      cwd: cfg.cwd, env, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const send = (data) => {
      if (!child.stdin?.destroyed && !child.stdin?.writableEnded) child.stdin.write(JSON.stringify(data) + '\n');
    };
    child.stdin?.on('error', (error) => { if (!closed && !resultSeen) fail(error); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    let buffer = '';
    let firstEvent = true;
    const line = (text) => {
      let event;
      try { event = JSON.parse(text); } catch { return; }
      if (firstEvent) {
        firstEvent = false;
        push({ type: 'gateway_timing', cli_first_event_ms: Math.round(performance.now() - start) });
      }
      if (cfg.sdkHostToken && event.type === 'control_request') {
        const subtype = event.request?.subtype;
        if (subtype === 'fetch_job_token') {
          send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id,
            response: { token: cfg.token } } });
        } else {
          send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id,
            response: { behavior: 'deny', message: 'Gateway disables local tools and host actions' } } });
        }
        return;
      }
      if (cfg.sdkHostToken && event.type === 'control_response' && event.response?.request_id === 'gateway-init') {
        if (event.response.subtype === 'error') return fail(new Error(event.response.error || 'Qoder initialization failed'));
        if (purpose === 'models') {
          resultSeen = true;
          push({ type: 'gateway_models', models: event.response.response?.models || [] });
          stop();
        } else {
          send({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null,
            message: { role: 'user', content: [{ type: 'text', text: prompt || '' }] } });
        }
        return;
      }
      if (event.type === 'result') {
        resultSeen = true;
        push(event);
        // SDK mode remains interactive after a turn. The upstream has finished;
        // terminate this owned one-turn worker instead of waiting for stdin forever.
        stop();
        return;
      }
      push(event);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const text = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        if (text) line(text);
      }
    });
    child.stdout.on('end', () => { if (buffer.trim()) line(buffer.trim()); });
    child.once('error', (error) => { fail(new Error(`${cfg.provider} CLI 无法启动: ${error.message}`)); });
    child.once('close', (code) => { closed = true; exitCode = code; wake?.(); });
    timer = setTimeout(() => { fail(new Error(`${cfg.provider} CLI timeout after ${cfg.timeoutMs}ms`)); stop(); }, cfg.timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (cfg.sdkHostToken) send({ type: 'control_request', request_id: 'gateway-init',
      request: { subtype: 'initialize', supportsCatalogReadyInitialize: true,
        supportsAvailableModelsUpdate: true, supportsPartialMessages: true } });
    else {
      // The CN CLI reads text from stdin when -p has no positional prompt.
      // Windows limits command-line length; tool schemas/history must never be argv.
      child.stdin.end(prompt || '', 'utf8');
    }
    for (;;) {
      if (terminalError) throw terminalError;
      if (queue.length) { yield queue.shift(); continue; }
      if (closed) break;
      await new Promise((resolve) => { wake = resolve; });
      wake = undefined;
    }
    if (terminalError) throw terminalError;
    if (!resultSeen) {
      const detail = stderr.replace(/(?:Bearer\s+|\b(?:dt|drt|jt)-)[^\s"']+/gi, '[redacted]').slice(-1200);
      throw new Error(`${cfg.provider} CLI exited without result (code ${exitCode}): ${detail || 'empty output'}`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    stop();
    if (tempDir && dirname(resolve(tempDir)) === resolve(tmpdir()) && basename(tempDir).startsWith('qoder-gateway-')) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
