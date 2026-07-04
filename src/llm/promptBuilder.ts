import { TableInfo } from "../db";
import { PreviousAttempt } from "./types";
import { formatSchema } from "./schema";
import { selectRelevantTables } from "./schemaFilter";
import { ModelConfig } from "./models";

export interface BuiltPrompt {
  system: string;
  user: string;
}

export async function buildPrompt(
  prompt: string,
  dialect: string,
  tables: TableInfo[],
  maxTables: number,
  config: ModelConfig,
  previousAttempt?: PreviousAttempt
): Promise<BuiltPrompt> {
  const relevantTables = await selectRelevantTables(prompt, tables, maxTables, config);
  const schemaText = formatSchema(relevantTables);

  const system = [
    `You translate English questions into a single ${dialect} SQL SELECT query.`,
    `Only use tables and columns from the schema below -- never invent names.`,
    `Only ever produce a read-only SELECT (or WITH ... SELECT) statement, never DDL/DML.`,
    `Respond with strict JSON: {"sql": "...", "explanation": "..."}. No markdown fences.`,
    ``,
    `Schema:`,
    schemaText,
  ].join("\n");

  const user = previousAttempt
    ? `${prompt}\n\nYour previous SQL failed when run against the real database:\nSQL: ${previousAttempt.sql}\nError: ${previousAttempt.error}\nFix it using only real table/column names from the schema above.`
    : prompt;

  return { system, user };
}
