import { test } from "node:test";
import assert from "node:assert/strict";
import { TableInfo } from "../db";
import { ModelConfig } from "./models";
import { selectRelevantTablesKeyword, selectRelevantTables } from "./schemaFilter";

function table(schema: string, name: string, columnNames: string[]): TableInfo {
  return { schema, name, columns: columnNames.map((n) => ({ name: n, dataType: "text", isNullable: true })) };
}

const TABLES: TableInfo[] = [
  table("pers", "employee_master", ["name", "gender"]),
  table("pers", "awards", ["user_id", "title"]),
  table("training", "training_master", ["course_name"]),
];

function ollamaConfig(): ModelConfig {
  return {
    id: "test-ollama",
    label: "test",
    shortLabel: "test",
    description: "test",
    badge: "local",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    model: "test-model",
    paramsB: 7,
  };
}

function openAiConfig(id: string): ModelConfig {
  return {
    id,
    label: "test",
    shortLabel: "test",
    description: "test",
    badge: "remote",
    provider: "openai-compatible",
    baseUrl: "http://localhost:3001",
    model: "test-model",
    embeddingModel: "test-embed",
    paramsB: 27,
  };
}

test("selectRelevantTablesKeyword returns everything when under the cap", () => {
  const result = selectRelevantTablesKeyword("anything", TABLES, 10);
  assert.equal(result.length, 3);
});

test("selectRelevantTablesKeyword ranks the table whose name/columns match the question", () => {
  const result = selectRelevantTablesKeyword("how many awards has each user won", TABLES, 1);
  assert.equal(result[0].name, "awards");
});

test("selectRelevantTables returns everything when under the cap, without a config", async () => {
  const result = await selectRelevantTables("anything", TABLES, 10);
  assert.equal(result.length, 3);
});

test("selectRelevantTables uses keyword scoring for the Ollama backend (no embeddings call)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch should not be called for the Ollama backend");
  }) as typeof fetch;
  try {
    const result = await selectRelevantTables("how many awards has each user won", TABLES, 1, ollamaConfig());
    assert.equal(result[0].name, "awards");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("selectRelevantTables uses semantic similarity for the Gemma/openai-compatible backend", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { input: string[] };
    const vectorFor = (text: string) => {
      if (text.includes("employee_master")) return [1, 0];
      if (text.includes("awards")) return [0, 1];
      if (text.includes("training_master")) return [0, -1];
      return [0, 1]; // the question itself -- crafted to point at "awards"
    };
    return {
      ok: true,
      json: async () => ({ data: body.input.map((t, i) => ({ embedding: vectorFor(t), index: i })) }),
    } as Response;
  }) as typeof fetch;

  try {
    // Deliberately no shared tokens with any table/column name -- a keyword
    // scorer would find nothing, but the mocked embeddings point straight
    // at "awards".
    const result = await selectRelevantTables("recognition given to staff", TABLES, 1, openAiConfig("test-semantic"));
    assert.equal(result[0].name, "awards");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("selectRelevantTables falls back to keyword scoring when the embeddings call fails", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("embeddings endpoint unreachable");
  }) as typeof fetch;

  try {
    const result = await selectRelevantTables(
      "how many awards has each user won",
      TABLES,
      1,
      openAiConfig("test-fallback")
    );
    assert.equal(result[0].name, "awards");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
