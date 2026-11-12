/** Harness compaction directive fixture; synthetic output, no product calls. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createQoderAdapter, isHarnessCompaction } from '../src/adapters/qoder.js';
import { CompletionState } from '../src/completion.js';

// Public compaction-basic template, not a user's captured conversation.
const directive = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '', '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '', '## Key Technical Concepts', '- [technologies, frameworks, patterns, and conventions in play]',
  '', '## Files and Code', '- [exact path: why it matters, key changes or snippets]',
  '', '## Errors and Fixes', '- [error: how it was resolved, plus any related user feedback]',
  '', '## Pending Jobs', '- [explicitly requested work not yet completed]',
  '', '## Current Work', '- [precisely what was in progress at this checkpoint]',
  '', '## Next Step', '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '', '## Critical Context', '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '', 'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n');
assert.equal(directive.length, 1802);
const messages = [{ role: 'user', content: directive }];
assert.equal(isHarnessCompaction(messages), true);
assert.equal(isHarnessCompaction([{ role: 'user', content: [{ type: 'text', text: directive }] }], 'auto'), true);
assert.equal(isHarnessCompaction([{ role: 'user', content: directive + ' ' }]), false);
assert.equal(isHarnessCompaction([{ role: 'assistant', content: directive }]), false);
assert.equal(isHarnessCompaction(messages, 'required'), false);
assert.equal(isHarnessCompaction(messages, { type: 'function', function: { name: 'fixture_probe' } }), false);

const root = await mkdtemp(join(tmpdir(), 'qoder-compaction-fixture-'));
const worker = join(root, 'worker.mjs');
const tools = [{ type: 'function', function: { name: 'fixture_probe', parameters: { type: 'object' } } }];
const historicalCall = '<tool_call>{"name":"fixture_probe","arguments":{"historical":true}}</tool_call>';
const mixedHistoricalCall = historicalCall.replace('</tool_call>', '</｜｜DSML｜｜ parameter>');
const summary = '## Errors and Fixes\n- Historical syntax: `<｜｜DSML｜｜ ...>`\n' + historicalCall + '\n' + mixedHistoricalCall;
await writeFile(worker, `process.stdin.resume();process.stdin.on('end',()=>{
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:${JSON.stringify(summary)}}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:${JSON.stringify(summary)}}));});`);
const cfg = { provider: 'fixture', exePath: process.execPath, workerPath: worker, cwd: root, timeoutMs: 3000 };
const adapter = createQoderAdapter({ name: 'fixture', getConfig: () => cfg, getModels: () => [] });
async function read(input, toolChoice) {
  const events = [], state = new CompletionState();
  for await (const event of adapter.stream({ model: 'fixture', messages: input, tools, toolChoice })) {
    events.push(event); state.observe(event);
  }
  state.complete();
  return { text: events.map(e => e.text || '').join(''), calls: events.filter(e => e.toolCall), state: state.snapshot() };
}
try {
  for (const choice of [undefined, 'auto', 'none']) {
    const result = await read(messages, choice);
    assert.equal(result.text, summary); assert.equal(result.calls.length, 0);
    assert.equal(result.state.finish_reason, 'stop'); assert.equal(result.state.request_purpose, 'compaction');
  }
  // Current explicit structured tool choices retain their normal meaning.
  const normal = await read([{ role: 'user', content: 'Please call the fixture tool.' }]);
  assert.equal(normal.calls.length, 2); assert.equal(normal.state.request_purpose, undefined);
  const required = await read(messages, 'required');
  assert.equal(required.calls.length, 2); assert.equal(required.state.request_purpose, undefined);
  console.log('PASS exact Harness compaction: summary references stay text, no tool execution, normal and required choices unchanged');
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
