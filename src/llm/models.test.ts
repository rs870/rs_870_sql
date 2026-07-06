import { test } from "node:test";
import assert from "node:assert/strict";
import { getModelConfig, listModelsForClient, DEFAULT_MODEL_ID } from "./models";

test("getModelConfig with no arguments returns the default model", () => {
  assert.equal(getModelConfig().id, DEFAULT_MODEL_ID);
});

test("getModelConfig resolves by explicit modelId", () => {
  assert.equal(getModelConfig("gemma-3-27b").id, "gemma-3-27b");
});

test("getModelConfig rejects an unknown modelId", () => {
  assert.throws(() => getModelConfig("does-not-exist"));
});

test("getModelConfig resolves by paramsB when modelId is omitted", () => {
  assert.equal(getModelConfig(undefined, 7).id, "qwen2.5-coder-7b");
  assert.equal(getModelConfig(undefined, 27).id, "gemma-3-27b");
});

test("getModelConfig rejects a paramsB with no matching model", () => {
  assert.throws(() => getModelConfig(undefined, 99), /No model configured with 99B/);
});

test("getModelConfig prefers modelId over paramsB when both are given", () => {
  assert.equal(getModelConfig("qwen2.5-coder-7b", 27).id, "qwen2.5-coder-7b");
});

test("listModelsForClient exposes paramsB but never connection details", () => {
  const list = listModelsForClient();
  for (const entry of list) {
    assert.equal(Object.keys(entry).sort().join(","), "badge,description,id,label,paramsB,shortLabel");
  }
});
