/** Offline adapter cancellation checks. No upstream HTTP requests are made. */
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { streamTrae } from '../src/adapters/trae.js';
import { streamSolo } from '../src/adapters/solo.js';

const originalFetch = globalThis.fetch;
const originalToken = config.trae.token;
const originalTraeTimeout = config.trae.timeoutMs;
const originalSoloTimeout = config.solo.timeoutMs;
config.trae.token = 'offline-test-token';
const encoder = new TextEncoder();
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const messages = [{ role: 'user', content: 'offline cancellation fixture' }];
const collect = async (stream) => { const events = []; for await (const event of stream) events.push(event); return events; };
async function deadline(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('cancellation check timed out')), 500);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

try {
  for (const stream of [streamTrae, streamSolo]) {
    const ac = new AbortController();
    ac.abort();
    let fetchCount = 0;
    globalThis.fetch = async (_url, { signal }) => {
      fetchCount++;
      assert.equal(signal.aborted, true);
      throw new DOMException('already aborted', 'AbortError');
    };
    await assert.rejects(() => collect(stream({ model: 'fixture', messages, signal: ac.signal })), /already aborted|已取消/);
    assert.equal(fetchCount, 1);
  }
  console.log('PASS pre-aborted signals reach both upstream fetches');

  // Non-2xx response bodies also remain bounded by the adapter timeout.
  config.trae.timeoutMs = 20;
  config.solo.timeoutMs = 20;
  for (const stream of [streamTrae, streamSolo]) {
    let aborted = false;
    globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => {
          aborted = true;
          controller.error(new DOMException('error body timeout', 'AbortError'));
        }, { once: true });
      },
    }), { status: 503 });
    await assert.rejects(() => deadline(collect(stream({ model: 'fixture', messages }))), /上游 503/);
    assert.equal(aborted, true);
  }
  config.trae.timeoutMs = originalTraeTimeout;
  config.solo.timeoutMs = originalSoloTimeout;
  console.log('PASS stalled error bodies retain timeouts for both adapters');

  let cancelCount = 0;
  let resolveCancellation;
  const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });
  globalThis.fetch = async (url, init) => {
    if (url.endsWith('/cancel_queue_task')) {
      cancelCount++;
      assert.equal(init.method, 'POST');
      assert.equal(JSON.parse(init.body).queue_id, 'queue-offline-test');
      resolveCancellation();
      return Response.json({ code: 0 });
    }
    assert.ok(url.endsWith(config.solo.chatPath));
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(frame('queue_begin', { queue_id: 'queue-offline-test' })
          + frame('request_wait_in_queue', { position: 2 })));
        init.signal.addEventListener('abort', () => controller.error(new DOMException('client cancelled', 'AbortError')), { once: true });
      },
    }));
  };
  const ac = new AbortController();
  const events = [];
  await assert.rejects(async () => {
    for await (const event of streamSolo({ model: 'fixture', messages, signal: ac.signal })) {
      events.push(event);
      if (event.status) ac.abort();
    }
  }, /client cancelled/);
  await deadline(cancellation);
  assert.equal(cancelCount, 1);
  assert.equal(events.some((event) => event.done), false);
  console.log('PASS queued client cancellation invokes upstream cancel exactly once');

  globalThis.fetch = async (url) => {
    if (url.endsWith('/cancel_queue_task')) {
      cancelCount++;
      return Response.json({ code: 0 });
    }
    return new Response(frame('queue_begin', { queue_id: 'normal-completion' }) + frame('done', {}));
  };
  const completed = await collect(streamSolo({ model: 'fixture', messages }));
  assert.equal(completed.some((event) => event.done), true);
  assert.equal(cancelCount, 1);
  console.log('PASS normal completion does not invoke queue cancellation');
} finally {
  globalThis.fetch = originalFetch;
  config.trae.token = originalToken;
  config.trae.timeoutMs = originalTraeTimeout;
  config.solo.timeoutMs = originalSoloTimeout;
}
