/** Completion evidence shared by streaming/non-streaming responses. No text is logged. */
const normalizedReason = (value) => {
  if (typeof value !== 'string') return null;
  const reason = value.toLowerCase();
  if (['length', 'max_tokens', 'max_output_tokens'].includes(reason)) return 'length';
  if (reason === 'content_filter') return reason;
  if (reason === 'function_call') return 'tool_calls';
  return ['stop', 'tool_calls'].includes(reason) ? reason : null;
};
const label = (value) => typeof value === 'string' && value ? value.slice(0, 128) : null;

export class CompletionState {
  constructor() {
    this.textChars = 0; this.reasoningChars = 0; this.hasText = false;
    this.slots = new Map(); this.upstreamFinishReason = null; this.adapterFinishReason = null;
    this.terminationReason = null; this.doneSeen = false; this.outcome = 'running'; this.errorCode = null;
    this.tokenCounts = {};
    this.attempts = []; this.recoveryAttempts = 0; this.recoveryRequested = false;
    this.requestPurpose = null;
  }
  observe(event) {
    if (event.requestPurpose === 'compaction') this.requestPurpose = 'compaction';
    const attempt = event.completionAttempt;
    if (attempt && (attempt.attempt === 1 || attempt.attempt === 2)) {
      const record = { attempt: attempt.attempt, phase: label(attempt.phase),
        finish_reason: label(attempt.finishReason), termination_reason: label(attempt.terminationReason),
        recovery_requested: attempt.recoveryRequested === true };
      for (const [key, source] of Object.entries({ text_chars: 'textChars', reasoning_chars: 'reasoningChars',
        tool_call_deltas: 'toolDeltas', elapsed_ms: 'elapsedMs', extra_info_version: 'extraInfoVersion', extra_info_input_tokens: 'extraInfoInputTokens',
        incoming_reasoning_messages: 'incomingReasoningMessages', replayed_reasoning_messages: 'replayedReasoningMessages',
        preserved_extra_info_messages: 'preservedExtraInfoMessages', missing_replay_profile_messages: 'missingReplayProfileMessages' })) {
        const value = attempt[source];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) record[key] = Math.round(value);
      }
      for (const [key, source] of Object.entries({ route: 'route', model: 'model', provider_model_name: 'providerModelName',
        cluster: 'cluster', extra_info_model: 'extraInfoModel' })) {
        if (label(attempt[source])) record[key] = label(attempt[source]);
      }
      if (typeof attempt.extraInfoPresent === 'boolean') record.extra_info_present = attempt.extraInfoPresent;
      if (typeof attempt.extraInfoVersion === 'string' && label(attempt.extraInfoVersion)) record.extra_info_version = label(attempt.extraInfoVersion);
      if (attempt.usage) {
        const usage = {};
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
          const value = attempt.usage[key];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[key] = value;
        }
        const reasoning = attempt.usage.completion_tokens_details?.reasoning_tokens;
        if (typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0) usage.reasoning_tokens = reasoning;
        if (Object.keys(usage).length) record.token_counts = usage;
      }
      const previous = this.attempts.findIndex((item) => item.attempt === record.attempt);
      if (previous >= 0) this.attempts[previous] = record;
      else this.attempts.push(record);
      this.recoveryAttempts = Math.max(this.recoveryAttempts, record.attempt - 1);
      this.recoveryRequested ||= record.recovery_requested;
    }
    if (typeof event.text === 'string') { this.textChars += event.text.length; this.hasText ||= Boolean(event.text.trim()); }
    if (typeof event.reasoning === 'string') this.reasoningChars += event.reasoning.length;
    if (event.toolCall) {
      const c = event.toolCall, index = Number.isInteger(c.index) ? c.index : 0;
      const slot = this.slots.get(index) || { name: '', fragments: [] };
      if (c.name) slot.name = c.name;
      if (typeof c.arguments === 'string') slot.fragments.push(c.arguments);
      this.slots.set(index, slot);
    }
    if (event.done) this.doneSeen = true;
    if (label(event.finishReason)) this.adapterFinishReason = label(event.finishReason);
    if (label(event.upstreamFinishReason)) this.upstreamFinishReason = label(event.upstreamFinishReason);
    if (label(event.terminationReason)) this.terminationReason = label(event.terminationReason);
    if (event.usage) {
      for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
        const value = event.usage[key];
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) this.tokenCounts[key] = value;
      }
      const reasoning = event.usage.completion_tokens_details?.reasoning_tokens;
      if (typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0) this.tokenCounts.reasoning_tokens = reasoning;
    }
  }
  get toolCalls() { return [...this.slots.values()].filter((slot) => slot.name).length; }
  get usageComplete() {
    return !this.attempts.length || this.attempts.every((attempt) =>
      ['prompt_tokens', 'completion_tokens', 'total_tokens'].every((key) => Number.isFinite(attempt.token_counts?.[key])));
  }
  get finishReason() {
    const reported = normalizedReason(this.upstreamFinishReason) || normalizedReason(this.adapterFinishReason);
    if (reported === 'length' || reported === 'content_filter') return reported;
    return this.toolCalls ? 'tool_calls' : 'stop';
  }
  reject(code, message) {
    throw Object.assign(new Error(message), { status: 502, type: 'upstream_error', code,
      upstreamFinishReason: this.upstreamFinishReason, terminationReason: this.terminationReason,
      recoveryAttempts: this.recoveryAttempts });
  }
  complete() {
    const reason = this.upstreamFinishReason || this.adapterFinishReason || '未提供';
    for (const slot of this.slots.values()) {
      if (!slot.name) this.reject('upstream_incomplete_tool_call', `上游工具调用缺少函数名，未正常完成（结束原因：${reason}）`);
      const argumentsText = slot.fragments.join('');
      // Keep historical zero-argument compatibility; nonempty argument JSON
      // must be complete before advertising a successful tool-call turn.
      if (argumentsText.trim()) {
        let args;
        try { args = JSON.parse(argumentsText); } catch {
          this.reject('upstream_incomplete_tool_call', `上游工具参数未完整返回，不能作为成功工具调用（结束原因：${reason}）`);
        }
        if (!args || typeof args !== 'object' || Array.isArray(args)) {
          this.reject('upstream_invalid_tool_arguments', '上游工具参数必须是 JSON 对象');
        }
      }
    }
    if (!this.toolCalls && normalizedReason(this.upstreamFinishReason || this.adapterFinishReason) === 'tool_calls') {
      this.reject('upstream_incomplete_tool_call', '上游以工具调用结束，但未返回完整的调用');
    }
    if (!this.hasText && !this.toolCalls) {
      const reasoningOnly = this.reasoningChars > 0;
      this.reject(reasoningOnly ? 'upstream_reasoning_only' : 'upstream_empty_response',
        `${reasoningOnly ? '上游只返回了思考，没有返回正文或工具调用' : '上游没有返回正文或工具调用'}（结束原因：${reason}）。${this.recoveryAttempts ? '已尝试补全一次，仍未得到可用答复。' : '本次响应未完成，请重试。'}`);
    }
    this.outcome = ['length', 'content_filter'].includes(this.finishReason) ? 'incomplete' : 'completed';
  }
  fail(error, cancelled = false) {
    this.outcome = cancelled ? 'client_disconnected' : 'error';
    this.errorCode = typeof error?.code === 'string' ? error.code : cancelled ? 'client_disconnected' : 'upstream_error';
  }
  snapshot() {
    return { outcome: this.outcome, text_chars: this.textChars, reasoning_chars: this.reasoningChars,
      ...(this.requestPurpose ? { request_purpose: this.requestPurpose } : {}),
      tool_calls: this.toolCalls, upstream_finish_reason: this.upstreamFinishReason,
      adapter_finish_reason: this.adapterFinishReason, termination_reason: this.terminationReason,
      adapter_done: this.doneSeen,
      upstream_done: this.terminationReason === 'upstream_done' ? true : this.terminationReason === 'tool_turn_boundary' ? false : null,
      finish_reason: this.outcome === 'error' || this.outcome === 'client_disconnected' ? null : this.finishReason,
      ...(Object.keys(this.tokenCounts).length ? { token_counts: { ...this.tokenCounts } } : {}),
      ...(this.attempts.length ? { recovery_attempts: this.recoveryAttempts, recovery_requested: this.recoveryRequested,
        usage_complete: this.usageComplete,
        generated_reasoning_chars: this.attempts.reduce((total, attempt) => total + (attempt.reasoning_chars || 0), 0),
        attempts: this.attempts.map((attempt) => ({ ...attempt })) } : {}),
      ...(this.errorCode ? { error_code: this.errorCode } : {}) };
  }
}

export function completionErrorDetails(error, completion) {
  return {
    ...(typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(label(error?.upstreamFinishReason) ? { upstream_finish_reason: label(error.upstreamFinishReason) } : {}),
    ...(label(error?.terminationReason) ? { termination_reason: label(error.terminationReason) } : {}),
    ...(Number.isInteger(error?.recoveryAttempts) ? { recovery_attempts: error.recoveryAttempts }
      : completion?.recoveryAttempts ? { recovery_attempts: completion.recoveryAttempts } : {}),
  };
}
