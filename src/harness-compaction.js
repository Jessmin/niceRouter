import { createHash } from 'node:crypto';

// Observed DSH compaction-basic final-user directive. Exact identity keeps
// cache-reused tool declarations from turning historical examples into actions.
const COMPACTION_SHA256 = '3b7aa71f525b9a82afc2f1747c4434ceb7b3bc1fadf8b64c37c4e97db70d074b';
export function isHarnessCompaction(messages, toolChoice) {
  if (toolChoice != null && !['auto', 'none'].includes(toolChoice)) return false;
  const last = Array.isArray(messages) ? messages.at(-1) : null;
  if (last?.role !== 'user') return false;
  let text = last.content;
  if (Array.isArray(text)) {
    if (!text.every(part => typeof part === 'string' || part?.type === 'text' && typeof part.text === 'string')) return false;
    text = text.map(part => typeof part === 'string' ? part : part.text).filter(Boolean).join('\n');
  }
  return typeof text === 'string' && text.length === 1802
    && createHash('sha256').update(text).digest('hex') === COMPACTION_SHA256;
}
