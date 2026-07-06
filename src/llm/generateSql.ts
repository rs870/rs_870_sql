import { TableInfo } from "../db";
import { GeneratedSql, PreviousAttempt } from "./types";
import { extractJson } from "./jsonExtract";
import { buildPrompt } from "./promptBuilder";
import { getModelConfig } from "./models";
import { callOllama } from "./providers/ollamaProvider";
import { callOpenAiCompat } from "./providers/openAiCompatProvider";

const OLLAMA_MAX_TABLES = Number(process.env.OLLAMA_MAX_TABLES ?? 20);

export interface GenerateSqlResult extends GeneratedSql {
  /** The model actually resolved and used -- echoes back which one, whether the caller picked it by id or by paramsB. */
  modelId: string;
}

/**
 * Turns an English prompt into a single read-only SQL query grounded in the
 * real schema. Dispatches to whichever model backend the caller picked --
 * by explicit `modelId`, or by `paramsB` (parameter count in billions, e.g.
 * a caller that just wants "the 27B model") -- a local Ollama model or a
 * self-hosted OpenAI-compatible server, but both go through the same
 * schema-filtering step (see llm/schemaFilter.ts) and the same JSON
 * parsing/validation.
 */
export async function generateSql(
  prompt: string,
  dialect: string,
  tables: TableInfo[],
  previousAttempt?: PreviousAttempt,
  modelId?: string,
  paramsB?: number
): Promise<GenerateSqlResult> {
  const config = getModelConfig(modelId, paramsB);
  const { system, user } = await buildPrompt(prompt, dialect, tables, OLLAMA_MAX_TABLES, config, previousAttempt);

  const rawText =
    config.provider === "ollama" ? await callOllama(system, user, config) : await callOpenAiCompat(system, user, config);

  let parsed: GeneratedSql;
  try {
    parsed = JSON.parse(extractJson(rawText)) as GeneratedSql;
  } catch (err) {
    throw new Error(
      `Model '${config.id}' did not return valid JSON. Raw response: ${rawText}`
    );
  }
  if (!parsed.sql) {
    throw new Error(`Model '${config.id}' did not return SQL. Raw response: ${rawText}`);
  }
  return { ...parsed, modelId: config.id };
}
