/** Per-request timings; no prompts, tool arguments or credentials are retained. */
export class RequestTiming {
  constructor({ provider, tools = 0, requestBytes = 0, now = () => performance.now() }) {
    this.now = now;
    this.start = now();
    this.values = { provider, tools_count: tools, request_bytes: requestBytes };
  }

  observe(event) {
    const elapsed = Math.round(this.now() - this.start);
    if (this.values.first_event_ms == null) this.values.first_event_ms = elapsed;
    for (const [key, present] of [
      ['first_reasoning_ms', event.reasoning],
      ['first_text_ms', event.text],
      ['first_tool_call_ms', event.toolCall],
    ]) {
      if (present && this.values[key] == null) this.values[key] = elapsed;
    }
    for (const key of ['queue_ms', 'upstream_headers_ms', 'cli_first_event_ms']) {
      const value = event.timing?.[key];
      if (Number.isFinite(value) && value >= 0) this.values[key] = Math.round(value);
    }
  }

  snapshot() {
    return { ...this.values, total_ms: Math.round(this.now() - this.start) };
  }
}
