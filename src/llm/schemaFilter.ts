import { TableInfo } from "../db";
import { ModelConfig } from "./models";
import { embedTexts } from "./providers/embeddingsProvider";

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .map((w) => (w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : w));
}

/**
 * Schema relevance filtering step.
 *
 * Ollama (and most locally-hosted models) default to a small context window
 * regardless of the model's real capacity, and this schema (173 tables /
 * ~2,200 columns) is far too large to fit alongside it on constrained
 * hardware. Rather than truncate the schema blindly -- which caused the
 * model to invent a nonexistent table during testing -- this step scores
 * every table against the question and keeps only the top `maxTables`. It's
 * the single highest-leverage change in this pipeline: without it the model
 * either can't see the right table at all, or drowns in irrelevant ones.
 *
 * Two scoring strategies are available:
 *  - keyword overlap (below) -- zero dependencies, works with any backend.
 *  - semantic/vector similarity (selectRelevantTablesSemantic) -- uses the
 *    H200 box's /v1/embeddings endpoint when the Gemma backend is selected,
 *    so e.g. "staff" can match a table named "employee_master" even though
 *    they share no tokens. Falls back to keyword scoring if the embeddings
 *    call fails (endpoint unreachable, model doesn't support embeddings).
 *
 * This is deliberately its own module (not buried inside a provider file)
 * so it applies identically no matter which LLM backend generates the SQL.
 */
export function selectRelevantTablesKeyword(prompt: string, tables: TableInfo[], maxTables: number): TableInfo[] {
  if (tables.length <= maxTables) {
    return tables;
  }
  const promptTokens = new Set(tokenize(prompt));
  const scored = tables.map((table) => {
    const nameTokens = tokenize(`${table.schema} ${table.name}`);
    const columnTokens = table.columns.flatMap((c) => tokenize(c.name));
    let score = 0;
    for (const tok of nameTokens) {
      if (promptTokens.has(tok)) score += 3;
    }
    for (const tok of columnTokens) {
      if (promptTokens.has(tok)) score += 1;
    }
    return { table, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxTables).map((s) => s.table);
}

function tableText(table: TableInfo): string {
  return `${table.schema}.${table.name} columns: ${table.columns.map((c) => c.name).join(", ")}`;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Table embeddings don't change unless the schema does, so they're computed
// once per model and reused across requests -- only the prompt needs a
// fresh embedding call each time.
const tableEmbeddingCache = new Map<string, Map<string, number[]>>();

async function getTableEmbeddings(tables: TableInfo[], config: ModelConfig): Promise<Map<string, number[]>> {
  let cache = tableEmbeddingCache.get(config.id);
  if (!cache) {
    cache = new Map();
    tableEmbeddingCache.set(config.id, cache);
  }
  const missing = tables.filter((t) => !cache!.has(`${t.schema}.${t.name}`));
  if (missing.length > 0) {
    const embeddings = await embedTexts(missing.map(tableText), config);
    missing.forEach((t, i) => cache!.set(`${t.schema}.${t.name}`, embeddings[i]));
  }
  return cache;
}

export async function selectRelevantTablesSemantic(
  prompt: string,
  tables: TableInfo[],
  maxTables: number,
  config: ModelConfig
): Promise<TableInfo[]> {
  const cache = await getTableEmbeddings(tables, config);
  const [promptEmbedding] = await embedTexts([prompt], config);
  const scored = tables.map((table) => ({
    table,
    score: cosineSimilarity(promptEmbedding, cache.get(`${table.schema}.${table.name}`)!),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxTables).map((s) => s.table);
}

/**
 * Entry point used by promptBuilder: tries semantic/vector filtering when
 * the selected backend exposes embeddings, otherwise (or on failure) falls
 * back to keyword overlap so a missing/unreachable embeddings endpoint
 * never blocks SQL generation.
 */
export async function selectRelevantTables(
  prompt: string,
  tables: TableInfo[],
  maxTables: number,
  config?: ModelConfig
): Promise<TableInfo[]> {
  if (tables.length <= maxTables) {
    return tables;
  }
  if (config?.provider === "openai-compatible" && config.embeddingModel) {
    try {
      return await selectRelevantTablesSemantic(prompt, tables, maxTables, config);
    } catch (err) {
      console.warn(
        `Semantic schema filtering failed (${err instanceof Error ? err.message : String(err)}); falling back to keyword filtering.`
      );
    }
  }
  return selectRelevantTablesKeyword(prompt, tables, maxTables);
}
