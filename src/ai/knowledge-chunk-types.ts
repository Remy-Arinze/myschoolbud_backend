/** Chunk types Lois may retrieve via search_semantic (handbooks / uploaded policy). */
export const DOCUMENT_KNOWLEDGE_TYPES = new Set(['policy', 'handbook', 'document']);

export function isDocumentKnowledgeChunk(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const meta = metadata as { type?: unknown; source?: unknown };
  const type = String(meta.type || '').toLowerCase();
  if (DOCUMENT_KNOWLEDGE_TYPES.has(type)) return true;
  return String(meta.source || '').toLowerCase() === 'upload';
}
