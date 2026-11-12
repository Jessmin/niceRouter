import { createHash } from 'node:crypto';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

export function createSoloReasoningStats() {
  return { incomingReasoningMessages: 0, replayedReasoningMessages: 0,
    preservedExtraInfoMessages: 0, missingReplayProfileMessages: 0 };
}

/** Only observed routing profiles are cached. Opaque response content and caller
 * reasoning are never retained. Keys are account/model/route hashes; values have
 * exactly model, version, observedAt. Access does not extend the observation TTL.
 */
export function createSoloReasoningBridge({ ttlMs = 2 * 60 * 60 * 1000, maxProfiles = 128, now = Date.now } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isInteger(maxProfiles) || maxProfiles <= 0) {
    throw new TypeError('Invalid SOLO reasoning profile cache limits');
  }
  const profiles = new Map();
  const keyOf = (scope) => {
    if (!scope || !nonempty(scope.token) || !nonempty(scope.model) || !nonempty(scope.route)) return null;
    return sha(JSON.stringify([sha(scope.token), scope.model, scope.route]));
  };
  const expire = () => {
    const time = now();
    for (const [key, profile] of profiles) {
      const age = time - profile.observedAt;
      if (!Number.isFinite(age) || age < 0 || age >= ttlMs) profiles.delete(key);
    }
    return time;
  };
  const getProfile = (scope) => {
    expire();
    const key = keyOf(scope), profile = key && profiles.get(key);
    if (!profile) return null;
    profiles.delete(key); profiles.set(key, profile);
    return { ...profile };
  };
  const learn = (scope, extraInfo) => {
    const key = keyOf(scope);
    if (!key || !object(extraInfo) || !nonempty(extraInfo.model)
      || !(nonempty(extraInfo.version) || Number.isFinite(extraInfo.version))
      || typeof extraInfo.content !== 'string') return false;
    let content;
    try { content = JSON.parse(extraInfo.content); } catch { return false; }
    if (!object(content) || Object.keys(content).length !== 1
      || typeof content.reasoning_content !== 'string' || !Object.hasOwn(content, 'reasoning_content')) return false;
    const time = expire();
    if (!Number.isFinite(time)) return false;
    // Do not retain extraInfo/content, even transiently inside the Map value.
    const profile = { model: extraInfo.model, version: extraInfo.version, observedAt: time };
    profiles.delete(key); profiles.set(key, profile);
    while (profiles.size > maxProfiles) profiles.delete(profiles.keys().next().value);
    return true;
  };
  const extraInfoFor = (message, scope, stats, { allowReplay = true } = {}) => {
    if (message?.role !== 'assistant') return undefined;
    const hasReasoning = nonempty(message.reasoning_content);
    if (hasReasoning && stats) stats.incomingReasoningMessages++;
    if (object(message.extra_info)) {
      if (stats) stats.preservedExtraInfoMessages++;
      return message.extra_info;
    }
    if (!hasReasoning || !allowReplay) return undefined;
    const profile = getProfile(scope);
    if (!profile) {
      if (stats) stats.missingReplayProfileMessages++;
      return undefined;
    }
    if (stats) stats.replayedReasoningMessages++;
    return { model: profile.model, version: profile.version,
      content: JSON.stringify({ reasoning_content: message.reasoning_content }) };
  };
  return { learn, getProfile, extraInfoFor, get size() { expire(); return profiles.size; } };
}
