/** Normalize the official product catalogue, not one agent's recommended menu. */
const SOURCE = 'WorkBuddy official product configuration: full model catalogue; metadata only, not per-model generation validation';
const MEDIA_TAGS = new Map([
  ['text-to-image', 'image'], ['image-to-image', 'image'],
  ['text-to-video', 'video'], ['image-to-video', 'video'],
  ['embedding', 'embedding'], ['embeddings', 'embedding'], ['text-embedding', 'embedding'],
  ['completion', 'completion'], ['code-completion', 'completion'], ['inline-completion', 'completion'],
]);
const boolean = (value) => typeof value === 'boolean' ? value : null;
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
const strings = (value) => Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item.length))] : [];
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

/**
 * Match the official remote configuration merge: remote IDs own the catalogue;
 * matching local definitions only supply missing top-level metadata. The one
 * gateway compatibility exception is an existing, verified `default` alias.
 */
export function resolveWorkbuddyProduct(base, remote) {
  if (!object(remote) || !Array.isArray(remote.models)) throw new TypeError('WorkBuddy remote product configuration must contain a models array');
  const local = object(base) ? base : {};
  const baseModels = new Map((Array.isArray(local.models) ? local.models : [])
    .filter((model) => object(model) && typeof model.id === 'string').map((model) => [model.id, model]));
  const models = remote.models.map((model) => {
    if (!object(model)) return model;
    const prior = baseModels.get(model.id);
    const merged = { ...prior, ...model };
    // A later real remote record supersedes our earlier compatibility marker.
    if (prior?.catalogOrigin === 'gateway-compatible-alias') {
      if (!Object.hasOwn(model, 'compatibilityAlias')) delete merged.compatibilityAlias;
      if (!Object.hasOwn(model, 'catalogOrigin')) delete merged.catalogOrigin;
    }
    return merged;
  });
  if (baseModels.has('default') && !remote.models.some((model) => model?.id === 'default')) {
    models.push({ ...baseModels.get('default'), compatibilityAlias: true, catalogOrigin: 'gateway-compatible-alias' });
  }
  return { ...local, ...remote, models };
}

function modelReferences(value, result = new Set()) {
  if (!object(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'model' && typeof item === 'string') result.add(item);
    else if (key === 'models' && Array.isArray(item)) for (const id of strings(item)) result.add(id);
    else if (object(item)) modelReferences(item, result);
  }
  return result;
}

function availability(model) {
  const disabled = model.disabled === true || model.enabled === false || model.isEnabled === false
    || (typeof model.status === 'string' && model.status.toLowerCase() === 'disabled');
  const hidden = model.hidden === true || model.isHidden === true || model.visible === false;
  return {
    disabled: disabled ? true : [model.disabled, model.enabled, model.isEnabled].some((flag) => typeof flag === 'boolean') ? false : null,
    hidden: hidden ? true : [model.hidden, model.isHidden, model.visible].some((flag) => typeof flag === 'boolean') ? false : null,
  };
}

function declaredCategory(model) {
  const tags = strings(model.tags).map((tag) => tag.toLowerCase());
  // The shipped CLI's generation menus use these tags, not supportsImages.
  for (const type of ['video', 'image', 'embedding', 'completion']) {
    if (tags.some((tag) => MEDIA_TAGS.get(tag) === type)) return type;
  }
  if (object(model.videoGeneration)) return 'video';
  const declared = [model.type, model.modelType, model.category].find((value) => typeof value === 'string')?.toLowerCase();
  if (['image', 'image-generation', 'image_generation'].includes(declared)) return 'image';
  if (['video', 'video-generation', 'video_generation'].includes(declared)) return 'video';
  if (['embedding', 'embeddings'].includes(declared)) return 'embedding';
  if (['completion', 'code-completion', 'inline-completion'].includes(declared)) return 'completion';
  return null;
}

function metadata(model, agents, completion) {
  const state = availability(model);
  const images = boolean(model.supportsImages);
  const disabledMultimodal = boolean(model.disabledMultimodal);
  return {
    id: model.id,
    display: typeof model.name === 'string' && model.name ? model.name : model.id,
    context: positive(model.maxInputTokens),
    maxOutputTokens: positive(model.maxOutputTokens),
    type: 'chat',
    capabilities: {
      chat: true,
      tools: boolean(model.supportsToolCall),
      vision: images == null ? null : images && disabledMultimodal !== true,
      supportsImages: images,
      disabledMultimodal,
      reasoning: boolean(model.supportsReasoning),
      reasoningOnly: boolean(model.onlyReasoning),
      canDisableThinking: boolean(model.canDisableThinking),
      completion,
    },
    agents: [...agents],
    tags: strings(model.tags),
    aliases: strings(model.aliases),
    availability: state,
    ...(model.id === 'default' || model.id === 'auto' ? { alias: true } : {}),
    ...(typeof model.compatibilityAlias === 'boolean' ? { compatibilityAlias: model.compatibilityAlias } : {}),
    ...(model.catalogOrigin === 'gateway-compatible-alias' ? { catalogOrigin: model.catalogOrigin } : {}),
    ...(typeof model.vendor === 'string' ? { vendor: model.vendor } : {}),
    ...(typeof model.credits === 'string' ? { credits: model.credits } : {}),
    ...(object(model.relatedModels) ? { relatedModels: Object.fromEntries(Object.entries(model.relatedModels).filter(([, id]) => typeof id === 'string')) } : {}),
  };
}

/**
 * @param {object|null} product Official product configuration (no credential fields are copied).
 * @returns {{models:object[], excluded:object[], source:string, summary:object}}
 */
export function buildWorkbuddyCatalog(product) {
  const entries = Array.isArray(product?.models) ? product.models : [];
  const agents = Array.isArray(product?.agents) ? product.agents.filter(object) : [];
  const completionIds = modelReferences(product?.completion);
  const unique = new Map();
  const excluded = [];
  const duplicateIds = new Set();
  let duplicateCount = 0;
  for (const model of entries) {
    if (!object(model) || typeof model.id !== 'string' || !model.id || model.id.trim() !== model.id) {
      excluded.push({ id: typeof model?.id === 'string' ? model.id : null, type: 'unknown', reason: 'invalid-model-id', reasonText: '模型记录没有有效 ID' });
      continue;
    }
    if (unique.has(model.id)) { duplicateCount++; duplicateIds.add(model.id); }
    // The official resolver indexes definitions by ID; the last definition wins.
    unique.set(model.id, model);
  }

  const groups = new Map([...unique.keys()].map((id) => [id, new Set()]));
  const unresolvedAgentModels = [];
  for (const agent of agents) {
    if (typeof agent.name !== 'string' || !agent.name) continue;
    for (const reference of strings(agent.models)) {
      const matched = unique.has(reference) ? [reference] : [...unique.values()]
        .filter((model) => strings(model.aliases).includes(reference) || model.name === reference).map((model) => model.id);
      if (matched.length === 1) groups.get(matched[0]).add(agent.name);
      else unresolvedAgentModels.push({ agent: agent.name, model: reference });
    }
    const tags = strings(agent.modelTags);
    if (tags.length) for (const model of unique.values()) {
      if (strings(model.tags).some((tag) => tags.includes(tag))) groups.get(model.id).add(agent.name);
    }
  }

  const models = [];
  for (const model of unique.values()) {
    const agentNames = groups.get(model.id);
    const completion = completionIds.has(model.id) || strings(model.aliases).some((alias) => completionIds.has(alias));
    const normalized = metadata(model, agentNames, completion);
    const category = declaredCategory(model);
    let reason = null, reasonText = null;
    if (category) {
      reason = category === 'completion' ? 'completion-only' : `${category}-generation`;
      if (category === 'embedding') reason = 'embedding';
      reasonText = { image: '官方元数据声明为图像生成/编辑', video: '官方元数据声明为视频生成', embedding: '配置声明为向量模型', completion: '配置声明为补全用途' }[category];
    } else if (normalized.availability.disabled === true) {
      reason = 'disabled'; reasonText = '配置明确禁用此模型';
    } else if (completion && agentNames.size === 0 && model.id !== 'default' && model.id !== 'auto') {
      reason = 'completion-only'; reasonText = '仅被官方补全配置引用，未被聊天 agent 引用';
    } else if (!(normalized.context && normalized.maxOutputTokens) && !agentNames.size && !normalized.alias) {
      reason = normalized.context ? 'missing-generation-budget' : 'missing-chat-context';
      reasonText = normalized.context ? '未提供文本生成预算，聊天用途尚未确认'
        : '未提供聊天上下文预算，可能为补全或辅助用途；未认定服务端不可聊天';
    }
    if (reason) {
      excluded.push({ ...normalized, type: category || (reason === 'completion-only' ? 'completion' : reason === 'missing-chat-context' ? 'auxiliary' : 'chat'),
        capabilities: { ...normalized.capabilities, chat: category || reason === 'completion-only' ? false : reason === 'disabled' ? true : null }, reason, reasonText });
    } else models.push(normalized);
  }
  const countsByReason = {};
  for (const model of excluded) countsByReason[model.reason] = (countsByReason[model.reason] || 0) + 1;
  return {
    models, excluded, source: SOURCE,
    summary: {
      catalogCount: entries.length, uniqueCount: unique.size, chatCount: models.length, excludedCount: excluded.length,
      duplicateCount, duplicateIds: [...duplicateIds], countsByReason,
      agentCount: agents.length, unresolvedAgentModels,
      validation: 'configuration-only; model generation and account entitlements not individually tested',
    },
  };
}
