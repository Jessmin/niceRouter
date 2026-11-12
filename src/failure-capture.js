/** Opt-in local failure evidence. Plaintext exists only in process/pipe memory. */
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const FAILURE_CAPTURE_MAX_BYTES = 4 * 1024 * 1024;
export const FAILURE_CAPTURE_WINDOW_MS = 60 * 60 * 1000;
const captureStartedAt = Date.now();
const MAX_ENCRYPTED_BYTES = FAILURE_CAPTURE_MAX_BYTES + 65536;
const ALLOWED_FIELDS = ['model', 'messages', 'tools', 'functions', 'tool_choice', 'temperature', 'max_tokens', 'stream'];
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
const budgetKey = Symbol.for('trae-gateway.failure-capture-budget.v1');
const budget = globalThis[budgetKey] ||= { reserved: 0 };
// Neither command contains interpolated data. CurrentUser DPAPI owns key storage.
const protectScript = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { Add-Type -AssemblyName System.Security; $source=[Console]::OpenStandardInput(); $buffer=New-Object System.IO.MemoryStream; $source.CopyTo($buffer); $result=[System.Security.Cryptography.ProtectedData]::Protect($buffer.ToArray(),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); $destination=[Console]::OpenStandardOutput(); $destination.Write($result,0,$result.Length); $destination.Flush(); } catch { [Console]::Error.WriteLine('DPAPI_OPERATION_FAILED'); exit 1; }";
const unprotectScript = "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { Add-Type -AssemblyName System.Security; $source=[Console]::OpenStandardInput(); $buffer=New-Object System.IO.MemoryStream; $source.CopyTo($buffer); $result=[System.Security.Cryptography.ProtectedData]::Unprotect($buffer.ToArray(),$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); $destination=[Console]::OpenStandardOutput(); $destination.Write($result,0,$result.Length); $destination.Flush(); } catch { [Console]::Error.WriteLine('DPAPI_OPERATION_FAILED'); exit 1; }";
const failure = (code) => Object.assign(new Error(code), { code });
const skipped = (reason, errorCode) => ({ captured: false, skipped: true, reason,
  ...(errorCode ? { errorCode } : {}) });

function requestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw failure('ERR_CAPTURE_BODY');
  const selected = {};
  for (const key of ALLOWED_FIELDS) if (Object.hasOwn(body, key)) selected[key] = body[key];
  return selected;
}

function qoderDiagnostic(value) {
  if (!value || !['qoder', 'qoder-intl'].includes(value.provider)
    || !['delta', 'assistant', 'result', 'message_stop', 'flush'].includes(value.source)
    || typeof value.upstreamText !== 'string' || typeof value.parserText !== 'string') return null;
  return { provider: value.provider, source: value.source,
    upstreamText: value.upstreamText.slice(-65536), parserText: value.parserText.slice(-65536),
    guardPending: typeof value.guardPending === 'string' ? value.guardPending.slice(0, 256) : '',
    toolCalls: Number.isSafeInteger(value.toolCalls) && value.toolCalls >= 0 ? value.toolCalls : 0 };
}

/** Numeric/role-only diagnostics; model names, IDs and business strings are omitted. */
export function summarizeCapturedRequest(body) {
  const selected = requestBody(body);
  const sizeBytes = Buffer.byteLength(JSON.stringify(selected), 'utf8');
  const messages = Array.isArray(selected.messages) ? selected.messages : [];
  const roles = {};
  let assistantWithReasoning = 0, assistantReasoningContentFields = 0,
    assistantWithReasoningContent = 0, assistantWithReasoningDetails = 0,
    assistantWithExtraInfo = 0, assistantToolCalls = 0, toolResults = 0;
  const roleOf = (message) => ROLES.has(message?.role) ? message.role : 'other';
  for (const message of messages) {
    const role = roleOf(message);
    roles[role] = (roles[role] || 0) + 1;
    if (role === 'tool' || role === 'function') toolResults++;
    if (role !== 'assistant') continue;
    const hasReasoningContent = typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0;
    const hasDetails = Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0;
    const hasTypedReasoning = Array.isArray(message.content) && message.content.some((part) =>
      part?.type === 'reasoning' || part?.type === 'thinking');
    if (Object.hasOwn(message, 'reasoning_content')) assistantReasoningContentFields++;
    if (hasReasoningContent) assistantWithReasoningContent++;
    if (hasDetails) assistantWithReasoningDetails++;
    if (hasReasoningContent || hasDetails || hasTypedReasoning ||
      (typeof message.reasoning === 'string' && message.reasoning.length > 0)) assistantWithReasoning++;
    if (Object.hasOwn(message, 'extra_info') && message.extra_info != null) assistantWithExtraInfo++;
    if (Array.isArray(message.tool_calls)) assistantToolCalls += message.tool_calls.length;
  }
  return { sizeBytes, messageCount: messages.length, roles, assistantWithReasoning,
    assistantReasoningContentFields, assistantWithReasoningContent, assistantWithReasoningDetails,
    assistantWithExtraInfo, assistantToolCalls, toolResults,
    toolsCount: Array.isArray(selected.tools) ? selected.tools.length : 0,
    functionsCount: Array.isArray(selected.functions) ? selected.functions.length : 0,
    tailRoles: messages.slice(-8).map(roleOf) };
}

function dpapi(bytes, decrypt = false) {
  if (process.platform !== 'win32') return Promise.reject(failure('ERR_DPAPI_UNAVAILABLE'));
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((accept, reject) => {
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', decrypt ? unprotectScript : protectScript],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [];
    let length = 0, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else accept(result);
    };
    const timer = setTimeout(() => { child.kill(); finish(failure('ERR_DPAPI_TIMEOUT')); }, 10000);
    child.on('error', (error) => finish(failure(error.code === 'ENOENT' ? 'ERR_DPAPI_UNAVAILABLE' : 'ERR_DPAPI_OPERATION')));
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > MAX_ENCRYPTED_BYTES) { child.kill(); finish(failure('ERR_DPAPI_OUTPUT_SIZE')); return; }
      chunks.push(chunk);
    });
    // Never relay PowerShell errors, which may include unrelated local diagnostics.
    child.stderr.resume();
    child.stdin.on('error', () => finish(failure('ERR_DPAPI_OPERATION')));
    child.on('close', (code) => {
      if (code !== 0 || length === 0) finish(failure('ERR_DPAPI_OPERATION'));
      else finish(null, Buffer.concat(chunks, length));
    });
    child.stdin.end(bytes);
  });
}

const isInside = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
async function diagnosticsDirectory(root) {
  const canonicalRoot = await realpath(resolve(root));
  let parent = canonicalRoot;
  for (const segment of ['.workbuddy', 'diagnostics']) {
    const candidate = join(parent, segment);
    try { await mkdir(candidate); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    parent = await realpath(candidate);
    if (!isInside(canonicalRoot, parent)) throw failure('ERR_CAPTURE_PATH');
  }
  return parent;
}

/** Never rejects: failure evidence must not replace or mask the original business error. */
export async function captureFailedRequest(options = {}) {
  let reserved = false;
  try {
    if (process.env.GATEWAY_FAILURE_CAPTURE !== '1') return skipped('disabled');
    const age = Date.now() - captureStartedAt;
    if (age < 0 || age >= FAILURE_CAPTURE_WINDOW_MS) return skipped('capture_window_closed');
    const { root, id, body, completion, error } = options || {};
    const snapshot = typeof completion?.snapshot === 'function' ? completion.snapshot() : completion;
    const code = snapshot?.error_code ?? snapshot?.errorCode ?? snapshot?.code;
    let diagnostic = null;
    if (code === 'upstream_invalid_tool_markup') {
      diagnostic = qoderDiagnostic(error?.qoderDiagnostic);
      if (!diagnostic || typeof body?.model !== 'string' || !body.model.startsWith(diagnostic.provider + '::')) {
        return skipped('qoder_diagnostic_missing');
      }
    } else if (code !== 'upstream_reasoning_only') return skipped('not_reasoning_only');
    if (typeof root !== 'string' || !root || typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
      return skipped('invalid_target');
    }
    const selected = requestBody(body);
    if (diagnostic) selected._gatewayQoderDiagnostic = diagnostic;
    const plaintext = Buffer.from(JSON.stringify(selected), 'utf8');
    if (plaintext.length > FAILURE_CAPTURE_MAX_BYTES) return skipped('body_too_large');
    if (process.platform !== 'win32') return skipped('unsupported_platform', 'ERR_DPAPI_UNAVAILABLE');
    if (budget.reserved >= 2) return skipped('capture_limit');
    budget.reserved++; reserved = true;
    const ciphertext = await dpapi(plaintext);
    const directory = await diagnosticsDirectory(root);
    const path = join(directory, `${id}.dpapi`);
    if (!isInside(directory, path)) throw failure('ERR_CAPTURE_PATH');
    const handle = await open(path, 'wx', 0o600);
    // A created file consumes a lifetime slot even if a subsequent disk write fails.
    reserved = false;
    try { await handle.writeFile(ciphertext); } finally { await handle.close(); }
    const summary = summarizeCapturedRequest(selected);
    if (diagnostic) summary.qoderDiagnostic = { source: diagnostic.source,
      upstreamChars: diagnostic.upstreamText.length, parserChars: diagnostic.parserText.length,
      toolCalls: diagnostic.toolCalls };
    return { captured: true, path, summary };
  } catch (error) {
    return skipped(error?.code === 'ERR_DPAPI_UNAVAILABLE' ? 'unsupported_platform' : 'capture_failed',
      typeof error?.code === 'string' && /^ERR_[A-Z_]+$/.test(error.code) ? error.code : 'ERR_CAPTURE_FAILED');
  } finally {
    if (reserved) budget.reserved--;
  }
}

/** Explicit local-only decryption for diagnostics/replay; never prints or uploads the body. */
export async function readCapturedRequest(path, { includeQoderDiagnostic = false } = {}) {
  if (process.platform !== 'win32') throw failure('ERR_DPAPI_UNAVAILABLE');
  if (typeof path !== 'string' || !path.endsWith('.dpapi')) throw failure('ERR_CAPTURE_PATH');
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_ENCRYPTED_BYTES) throw failure('ERR_CAPTURE_FILE_SIZE');
  const plaintext = await dpapi(await readFile(path), true);
  if (plaintext.length > FAILURE_CAPTURE_MAX_BYTES) throw failure('ERR_CAPTURE_BODY_SIZE');
  let decoded;
  try { decoded = JSON.parse(plaintext.toString('utf8')); } catch { throw failure('ERR_CAPTURE_FORMAT'); }
  const selected = requestBody(decoded);
  if (includeQoderDiagnostic) {
    const diagnostic = qoderDiagnostic(decoded._gatewayQoderDiagnostic);
    if (diagnostic) selected._gatewayQoderDiagnostic = diagnostic;
  }
  return selected;
}
