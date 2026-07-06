import { test } from "node:test";
import assert from "node:assert/strict";
import { getDatabaseConfig, listDatabasesForClient, DEFAULT_DATABASE_ID } from "./databases";

test("getDatabaseConfig with no id returns the default database", () => {
  const config = getDatabaseConfig(undefined);
  assert.equal(config.id, DEFAULT_DATABASE_ID);
});

test("getDatabaseConfig rejects an unknown id", () => {
  assert.throws(() => getDatabaseConfig("does-not-exist"));
});

test("getDatabaseConfig rejects a registered but unconfigured database", () => {
  // db2-placeholder has no host/database set until DB2_* env vars are provided.
  assert.throws(() => getDatabaseConfig("db2-placeholder"), /not been configured|has no connection configured/i);
});

test("listDatabasesForClient never leaks credentials", () => {
  const list = listDatabasesForClient();
  for (const entry of list) {
    assert.equal(Object.keys(entry).sort().join(","), "configured,id,label");
  }
});

test("listDatabasesForClient flags the placeholder database as not configured", () => {
  const list = listDatabasesForClient();
  const placeholder = list.find((d) => d.id === "db2-placeholder");
  assert.ok(placeholder);
  assert.equal(placeholder!.configured, false);
});
