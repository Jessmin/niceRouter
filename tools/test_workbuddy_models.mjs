/** Offline catalogue checks; never launches a product or invokes a model. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { workbuddyCliEnv } from '../src/adapters/workbuddy.js';
import { workbuddyConfig } from '../src/workbuddy-config.js';
import { buildWorkbuddyCatalog, resolveWorkbuddyProduct } from '../src/workbuddy-models.js';

let checks = 0;
function test(name, check) { check(); checks++; console.log(`PASS ${name}`); }
const chat = (id, fields = {}) => ({ id, name: id, maxInputTokens: 96000, maxOutputTokens: 8192, ...fields });

test('full catalogue adds chat models outside the CLI recommendation list', () => {
  const product = { models: [chat('default'), chat('auto'), chat('old-cli'), chat('deepseek-v4-pro'), chat('glm-5.3'), chat('kimi-k3-2'), chat('hy4-preview')],
    agents: [{ name: 'cli', models: ['old-cli'] }] };
  const result = buildWorkbuddyCatalog(product);
  assert.equal(result.models.length, 7);
  assert.deepEqual(result.models.find((model) => model.id === 'old-cli').agents, ['cli']);
  assert.deepEqual(result.models.find((model) => model.id === 'glm-5.3').agents, []);
  assert.equal(result.models.find((model) => model.id === 'default').alias, true);
  assert.equal(result.models.find((model) => model.id === 'auto').alias, true);
});
test('official generation tags distinguish output media from vision input', () => {
  const result = buildWorkbuddyCatalog({ models: [
    chat('vision-chat', { supportsImages: true, supportsToolCall: true }),
    chat('image', { tags: ['text-to-image'], supportsImages: true }),
    chat('edit-image', { tags: ['image-to-image'] }),
    chat('video', { tags: ['text-to-video'] }),
    chat('image-video', { tags: ['image-to-video'] }),
    chat('video-metadata', { videoGeneration: { maxSeconds: 15 } }),
    chat('embedding', { tags: ['embedding'] }),
  ] });
  assert.deepEqual(result.models.map((model) => model.id), ['vision-chat']);
  assert.equal(result.models[0].capabilities.vision, true);
  assert.deepEqual(result.excluded.map((model) => model.type), ['image', 'image', 'video', 'video', 'video', 'embedding']);
});
test('supportsExtra and missing tool flags never remove budgeted LLMs', () => {
  const result = buildWorkbuddyCatalog({ models: [
    chat('deepseek-r1-0528', { supportsExtra: true }), chat('deepseek-v3-0324'),
    chat('completion-gf', { maxInputTokens: 200000, supportsExtra: true, supportsToolCall: true, supportsImages: true }),
    { id: 'small-auxiliary', name: 'auxiliary', maxOutputTokens: 256, supportsExtra: true },
  ] });
  assert.equal(result.models.length, 3);
  assert.equal(result.models[0].capabilities.tools, null);
  assert.equal(result.models.find((model) => model.id === 'completion-gf').context, 200000);
  assert.equal(result.excluded[0].reason, 'missing-chat-context');
  assert.equal(result.excluded[0].capabilities.chat, null);
  assert.match(result.excluded[0].reasonText, /未认定服务端不可聊天/);
});
test('explicit completion references are separated; dual-use chat remains', () => {
  const result = buildWorkbuddyCatalog({ models: [chat('completion-route'), chat('dual-use'), chat('tagged-completion', { tags: ['inline-completion'] })],
    completion: { model: 'completion-route', nested: { models: ['dual-use'] } }, agents: [{ name: 'cli', models: ['dual-use'] }] });
  assert.deepEqual(result.models.map((model) => model.id), ['dual-use']);
  assert.equal(result.models[0].capabilities.completion, true);
  assert.deepEqual(result.excluded.map((model) => model.reason), ['completion-only', 'completion-only']);
});
test('same display names preserve distinct IDs and exact budgets', () => {
  const result = buildWorkbuddyCatalog({ models: [chat('hy3', { name: 'Hy3', maxInputTokens: 192000 }), chat('hy3-x', { name: 'Hy3', maxInputTokens: 1000000 })] });
  assert.deepEqual(result.models.map((model) => model.id), ['hy3', 'hy3-x']);
  assert.deepEqual(result.models.map((model) => model.context), [192000, 1000000]);
});
test('explicit disabled entries stay explained; hidden entries stay discoverable', () => {
  const result = buildWorkbuddyCatalog({ models: [chat('disabled', { disabled: true }), chat('not-enabled', { enabled: false }), chat('hidden', { hidden: true })] });
  assert.deepEqual(result.models.map((model) => model.id), ['hidden']);
  assert.equal(result.models[0].availability.hidden, true);
  assert.deepEqual(result.excluded.map((model) => model.reason), ['disabled', 'disabled']);
  assert.equal(result.excluded[0].capabilities.chat, true);
});
test('duplicate IDs follow the official map, without merging different models', () => {
  const result = buildWorkbuddyCatalog({ models: [chat('same', { name: 'old', disabled: true }), chat('same', { name: 'new' }), chat('other', { name: 'new' })] });
  assert.deepEqual(result.models.map((model) => model.display), ['new', 'new']);
  assert.equal(result.summary.duplicateCount, 1);
  assert.deepEqual(result.summary.duplicateIds, ['same']);
});
test('agent IDs, unique aliases and model tags retain group metadata', () => {
  const result = buildWorkbuddyCatalog({ models: [chat('one', { tags: ['craft'], aliases: ['one-alias'] }), { id: 'budget-less', name: 'budget-less' }],
    agents: [{ name: 'cli', models: ['one-alias'], modelTags: ['craft'] }, { name: 'helper', models: ['budget-less', 'builtin-lite'] }] });
  assert.deepEqual(result.models.find((model) => model.id === 'one').agents, ['cli']);
  assert.deepEqual(result.models.find((model) => model.id === 'budget-less').agents, ['helper']);
  assert.equal(result.models.find((model) => model.id === 'budget-less').context, null);
  assert.deepEqual(result.summary.unresolvedAgentModels, [{ agent: 'helper', model: 'builtin-lite' }]);
});
test('model metadata preserves reasoning and multimodal state without credentials', () => {
  const result = buildWorkbuddyCatalog({ models: [chat('reasoner', { supportsReasoning: true, onlyReasoning: true, canDisableThinking: false,
    supportsImages: true, disabledMultimodal: true, apiKey: 'secret-do-not-copy', endpoint: 'https://secret.example' })], authentication: { token: 'secret-do-not-copy' } });
  const model = result.models[0];
  assert.equal(model.type, 'chat'); assert.equal(model.capabilities.reasoning, true);
  assert.equal(model.capabilities.supportsImages, true); assert.equal(model.capabilities.vision, false);
  assert.equal(JSON.stringify(result).includes('secret-do-not-copy'), false);
  assert.equal(JSON.stringify(result).includes('secret.example'), false);
  assert.match(result.source, /metadata only/);
});
test('missing or invalid configuration never invents aliases or models', () => {
  for (const product of [null, undefined, {}, { models: null }, { models: 'not-an-array' }]) {
    const result = buildWorkbuddyCatalog(product);
    assert.deepEqual(result.models, []); assert.deepEqual(result.excluded, []);
    assert.equal(result.summary.catalogCount, 0);
  }
  const invalid = buildWorkbuddyCatalog({ models: [null, { name: 'no id' }, { id: ' whitespace ' }] });
  assert.equal(invalid.excluded.length, 3);
  assert.ok(invalid.excluded.every((model) => model.reason === 'invalid-model-id'));
});

test('remote IDs replace the old set while shared model metadata shallow-merges', () => {
  const base = { models: [chat('old-only'), chat('shared', { supportsImages: true, maxInputTokens: 96000,
    reasoning: { effort: 'low', legacy: true }, tags: ['old-tag'] })],
    agents: [{ name: 'old-agent' }], config: { oldSetting: true } };
  const remote = { models: [{ id: 'shared', name: 'Shared remote', maxInputTokens: 200000,
    reasoning: { effort: 'high' }, tags: ['new-tag'] }, chat('new-only')],
    agents: [{ name: 'new-agent' }], config: { newSetting: true } };
  const merged = resolveWorkbuddyProduct(base, remote);
  assert.deepEqual(merged.models.map((model) => model.id), ['shared', 'new-only']);
  assert.equal(merged.models[0].supportsImages, true);
  assert.equal(merged.models[0].maxInputTokens, 200000);
  assert.deepEqual(merged.models[0].reasoning, { effort: 'high' });
  assert.deepEqual(merged.models[0].tags, ['new-tag']);
  assert.deepEqual(merged.agents, remote.agents);
  assert.deepEqual(merged.config, remote.config);
  assert.equal(base.models[1].name, 'shared');
  assert.equal(remote.models[0].supportsImages, undefined);
});
test('only an existing default alias survives removal from the remote catalogue', () => {
  const base = { models: [chat('default'), chat('auto'), chat('removed')] };
  const merged = resolveWorkbuddyProduct(base, { models: [chat('latest')] });
  assert.deepEqual(merged.models.map((model) => model.id), ['latest', 'default']);
  assert.equal(merged.models[1].compatibilityAlias, true);
  assert.equal(merged.models[1].catalogOrigin, 'gateway-compatible-alias');
  const normalized = buildWorkbuddyCatalog(merged).models.find((model) => model.id === 'default');
  assert.equal(normalized.compatibilityAlias, true);
  assert.equal(normalized.catalogOrigin, 'gateway-compatible-alias');
  assert.deepEqual(resolveWorkbuddyProduct({ models: [chat('old')] }, { models: [chat('latest')] }).models.map((model) => model.id), ['latest']);
  assert.deepEqual(resolveWorkbuddyProduct(null, { models: [] }).models, []);
});
test('a remote default wins and removes stale gateway compatibility provenance', () => {
  const base = { models: [chat('default', { compatibilityAlias: true, catalogOrigin: 'gateway-compatible-alias', name: 'Local default' })] };
  const merged = resolveWorkbuddyProduct(base, { models: [chat('default', { name: 'Remote default', maxInputTokens: 400000 })] });
  assert.equal(merged.models.length, 1);
  assert.equal(merged.models[0].name, 'Remote default');
  assert.equal(merged.models[0].maxInputTokens, 400000);
  assert.equal(merged.models[0].compatibilityAlias, undefined);
  assert.equal(merged.models[0].catalogOrigin, undefined);
});
test('an explicit empty remote catalogue is not replaced with stale local models', () => {
  assert.deepEqual(resolveWorkbuddyProduct({ models: [chat('old-only')] }, { models: [] }).models, []);
  assert.deepEqual(resolveWorkbuddyProduct({ models: [chat('default'), chat('old-only')] }, { models: [] }).models.map((model) => model.id), ['default']);
  assert.throws(() => resolveWorkbuddyProduct({ models: [] }, {}), /models array/);
});

test('a signed-in installation can use a catalogue before the first official cache exists', () => {
  const installDir = mkdtempSync(join(tmpdir(), 'nice-router-workbuddy-'));
  const cfg = { ...workbuddyConfig, installDir, configDir: installDir,
    exePath: join(installDir, 'WorkBuddy.exe'), cliPath: join(installDir, 'cli', 'bin', 'codebuddy'),
    authFile: join(installDir, 'desktop.info'), productFile: join(installDir, 'cache', 'product.json'),
    modelsFile: join(installDir, 'models.json') };
  const appArchive = join(installDir, 'resources', 'app.asar');
  const packagedProduct = join(installDir, 'cli', 'product.json');
  try {
    for (const file of [cfg.exePath, cfg.cliPath, cfg.authFile, appArchive]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'fixture');
    }
    writeFileSync(packagedProduct, JSON.stringify({ models: [chat('default'), chat('packaged-model')] }));
    writeFileSync(cfg.modelsFile, JSON.stringify({ models: [{ id: 'snapshot-model' }] }));

    assert.equal(existsSync(cfg.productFile), false);
    assert.equal(cfg.enabled(), true);
    assert.deepEqual(cfg.models().map(({ id }) => id), ['snapshot-model']);
    assert.equal(workbuddyCliEnv(cfg).ACC_PRODUCT_CONFIG_PATH, undefined);

    rmSync(cfg.modelsFile);
    assert.deepEqual(cfg.models().map(({ id }) => id), ['default', 'packaged-model']);

    mkdirSync(dirname(cfg.productFile));
    writeFileSync(cfg.productFile, 'invalid product data');
    assert.equal(workbuddyCliEnv(cfg).ACC_PRODUCT_CONFIG_PATH, undefined);
    writeFileSync(cfg.productFile, JSON.stringify({ models: [chat('cached-model')] }));
    assert.deepEqual(cfg.models().map(({ id }) => id), ['cached-model', 'default']);
    assert.equal(workbuddyCliEnv(cfg).ACC_PRODUCT_CONFIG_PATH, cfg.productFile);

    rmSync(cfg.productFile);
    mkdirSync(cfg.productFile);
    assert.equal(cfg.enabled(), true);
    assert.deepEqual(cfg.models().map(({ id }) => id), ['default', 'packaged-model']);
    assert.equal(workbuddyCliEnv(cfg).ACC_PRODUCT_CONFIG_PATH, undefined);
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
});

const cache = join(homedir(), '.workbuddy', 'cache', 'acc-product-config-v3.json');
if (existsSync(cache)) test('installed product catalogue includes newly missed chat models', () => {
  const product = JSON.parse(readFileSync(cache, 'utf8'));
  const result = buildWorkbuddyCatalog(product);
  const ids = new Set(result.models.map((model) => model.id));
  for (const id of ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4.1-flash', 'glm-5.3', 'glm-5.2', 'kimi-k3-2', 'hy4-preview', 'completion-gf', 'deepseek-r1-0528', 'deepseek-v3-0324']) {
    if (product.models.some((model) => model.id === id)) assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.equal(result.models.length, new Set(result.models.map((model) => model.id)).size);
  assert.ok(result.excluded.every((model) => model.reason));
  console.log(`Installed metadata: ${result.summary.catalogCount} total, ${result.summary.chatCount} chat, ${result.summary.excludedCount} excluded (no model calls).`);
});
console.log(`${checks} WorkBuddy catalogue fixture groups passed (offline).`);
