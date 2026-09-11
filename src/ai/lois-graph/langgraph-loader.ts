/**
 * Dynamic import so Nest's CommonJS build can load ESM LangGraph packages.
 */
export type LangGraphModule = typeof import('@langchain/langgraph');
export type PostgresCheckpointModule = typeof import('@langchain/langgraph-checkpoint-postgres');

let langgraphMod: LangGraphModule | null = null;
let postgresMod: PostgresCheckpointModule | null = null;

export async function loadLangGraph(): Promise<LangGraphModule> {
  if (!langgraphMod) {
    langgraphMod = await import('@langchain/langgraph');
  }
  return langgraphMod;
}

export async function loadPostgresCheckpoint(): Promise<PostgresCheckpointModule> {
  if (!postgresMod) {
    postgresMod = await import('@langchain/langgraph-checkpoint-postgres');
  }
  return postgresMod;
}

export async function loadMemorySaver(): Promise<new () => unknown> {
  const mod = await import('@langchain/langgraph-checkpoint');
  return mod.MemorySaver;
}
