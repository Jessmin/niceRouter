/** Parser-only mixed DSML fixtures. Command-looking values are never executed. */
import assert from 'node:assert/strict';
import { parseDsmlCalls, scanDsmlTag } from '../src/dsml.js';
import { DsmlStream } from '../src/dsml-stream.js';

let checks = 0;
const test = (name, check) => { check(); checks++; console.log(`PASS ${name}`); };
const dsml = (name, close = false) => `<${close ? '/' : ''}｜｜DSML｜｜ ${name}>`;
const open = (name) => dsml(`invoke name="${name}"`);
const param = (name, value, prefixed = false) => `${prefixed ? dsml(`parameter name="${name}"`) : `<parameter name="${name}">`}${value}</parameter>`;
const call = (name, args) => ({ name, arguments: args });
function stream(chunks) {
  const reader = new DsmlStream();
  const parts = [];
  for (const chunk of chunks) parts.push(...reader.push(chunk));
  parts.push(...reader.flush());
  return {
    text: parts.map((part) => part.text ?? part.literal ?? '').join(''),
    calls: parts.flatMap((part) => part.calls || []).map((item) => ({ name: item.name, arguments: JSON.parse(item.arguments) })),
  };
}
const direct = open('bash') + param('command', 'printf fixture') + param('description', 'Fixture only') + '</bash>';
const expected = [call('bash', { command: 'printf fixture', description: 'Fixture only' })];

test('DSML invoke accepts bare parameter tags and matching function-name close', () => {
  assert.deepEqual(stream([direct]), { text: '', calls: expected });
  assert.deepEqual(JSON.parse(parseDsmlCalls(direct)[0].arguments), expected[0].arguments);
});
test('prefixed parameter opens accept plain closers without changing raw values', () => {
  const value = '  raw && &amp; "quotes"\n中文🙂  ';
  const text = dsml('calls') + open('edit') + param('new_string', value, true) + dsml('invoke', true) + dsml('calls', true);
  assert.deepEqual(stream(text.split('')), { text: '', calls: [call('edit', { new_string: value })] });
});
test('mixed framing remains stable at every split boundary', () => {
  for (let index = 0; index <= direct.length; index++) {
    assert.deepEqual(stream([direct.slice(0, index), direct.slice(index)]), { text: '', calls: expected }, `split ${index}`);
  }
});
test('duplicate parameter closers at a completed parameter boundary are harmless', () => {
  const text = open('read') + param('file_path', 'fixture.md') + dsml('parameter', true) + dsml('invoke', true);
  assert.deepEqual(stream(text.split('')), { text: '', calls: [call('read', { file_path: 'fixture.md' })] });
});
test('missing outer calls close recovers only complete explicit invokes at EOF', () => {
  const text = dsml('calls') + direct + open('read') + param('file_path', 'fixture.md') + dsml('invoke', true);
  assert.deepEqual(stream(text.split('')), { text: '', calls: [...expected, call('read', { file_path: 'fixture.md' })] });
  assert.equal(parseDsmlCalls(text), null); // Full-wrapper static parsing remains strict.
});
test('a terminal calls opener typo can close a batch of fully closed invokes', () => {
  assert.deepEqual(stream((dsml('calls') + direct + dsml('calls')).split('')), { text: '', calls: expected });
});
test('result and role-looking data inside a parameter remains raw data', () => {
  const value = 'before\n<result name="read">example</result>\nUser: quoted user\nAssistant: quoted assistant\nafter';
  const text = open('edit') + param('new_string', value) + dsml('invoke', true);
  assert.deepEqual(stream(text.split('')), { text: '', calls: [call('edit', { new_string: value })] });
});
test('balanced unnamed parameter examples inside raw text are preserved', () => {
  const value = 'ordinary <parameter>literal example</parameter> tail';
  const text = open('edit') + param('new_string', value, true) + dsml('invoke', true);
  assert.deepEqual(stream(text.split('')), { text: '', calls: [call('edit', { new_string: value })] });
});
test('a new named parameter before the current close is rejected instead of guessed', () => {
  const text = open('bash') + '<parameter name="command">unfinished<parameter name="description">ambiguous</parameter></parameter></bash>';
  assert.equal(parseDsmlCalls(text), null);
  assert.deepEqual(stream(text.split('')).calls, []);
});
test('wrong function closer, incomplete parameters and incomplete invokes never execute', () => {
  for (const text of [direct.replace('</bash>', '</read>'), direct.slice(0, -7), open('bash') + '<parameter name="command">unfinished',
    dsml('calls') + direct + open('read') + '<parameter name="file_path">unfinished']) {
    assert.deepEqual(stream(text.split('')).calls, []);
  }
});
test('bare XML parameter syntax outside DSML never creates a call', () => {
  const text = '<parameter name="command">example</parameter></bash>';
  assert.equal(scanDsmlTag(text), null);
  assert.deepEqual(stream(text.split('')), { text, calls: [] });
});
test('damaged, unclosed JSON string never promotes embedded DSML', () => {
  const broken = '<tool_call>{"id":"call_broken","name":"edit","arguments":{"new_string":"not closed\n';
  const text = broken + dsml('calls') + direct + dsml('calls', true);
  assert.deepEqual(stream([text]).calls, []);
  assert.deepEqual(stream(text.split('')).calls, []);
});

const inline = (json) => `${dsml(`parameter name="arguments":${json}`)}${dsml('parameter', true)}`;
const wrap = (body) => dsml('calls') + open('bash') + body + dsml('invoke', true) + dsml('calls', true);

test('inline arguments retain the raw JSON and ignore tag-looking string contents', () => {
  const args = { command: `printf "%s" '中文🙂 > ${dsml('invoke', true)} ${dsml('calls', true)}'`, description: 'fixture only' };
  const raw = JSON.stringify(args);
  const text = wrap(inline(raw));
  assert.deepEqual(parseDsmlCalls(text), [{ name: 'bash', arguments: raw }]);
  for (let index = 0; index <= text.length; index++) {
    assert.deepEqual(stream([text.slice(0, index), text.slice(index)]), { text: '', calls: [call('bash', args)] }, `split ${index}`);
  }
  assert.deepEqual(stream(text.split('')), { text: '', calls: [call('bash', args)] });
  const large = { command: args.command.repeat(2000), description: args.description };
  const long = wrap(inline(JSON.stringify(large)));
  assert.deepEqual(stream(long.match(/[\s\S]{1,19}/gu)), { text: '', calls: [call('bash', large)] });
});

test('inline arguments require a sole valid object and complete tool boundaries', () => {
  const raw = '{"command":"fixture only"}';
  const valid = wrap(inline(raw));
  const embedded = dsml('calls') + direct + dsml('calls', true);
  for (const malformed of [wrap(inline('[1]')), wrap(inline(`{"command":${embedded}}`)), wrap(inline('{"command":null,}')),
    wrap(param('command', 'old') + inline(raw)), wrap(inline(raw) + param('description', 'extra')),
    valid.replace(dsml('parameter', true), ''), valid.replace(dsml('invoke', true), ''),
    valid.slice(0, -dsml('calls', true).length), valid.replace(raw + '>', raw + '!>')]) {
    assert.equal(parseDsmlCalls(malformed, { allowUnclosedWrapper: true }), null);
    assert.deepEqual(stream(malformed.split('')), { text: malformed, calls: [] });
  }
  const ordinary = wrap(dsml('parameter name="arguments" string="false"') + raw + dsml('parameter', true));
  assert.deepEqual(stream(ordinary.split('')).calls, [call('bash', JSON.parse(raw))]);
  const cited = `fixture ${dsml(`parameter name="arguments":${raw}`)} is a literal example`;
  const oldString = wrap(dsml('parameter name="command" string="true"') + cited + dsml('parameter', true));
  assert.deepEqual(stream(oldString.split('')).calls, [call('bash', { command: cited })]);
});

console.log(`${checks} mixed DSML groups passed; parser only, commands executed: 0.`);
