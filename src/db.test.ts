import { test } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import * as db from "./db";
import { UnsafeSqlError } from "./sqlGuard";

// These tests run against the real restored `nextgendb` database (see
// PROJECT.md for how to start it). They're read-only: listTables() only
// reads information_schema, and executeReadOnlyQuery() always runs inside
// a transaction that gets rolled back.

test("listTables returns real tables from the pers schema", async () => {
  const tables = await db.listTables();
  assert.ok(tables.length > 0, "expected at least one table");
  const employeeMaster = tables.find((t) => t.schema === "pers" && t.name === "employee_master");
  assert.ok(employeeMaster, "expected pers.employee_master to exist");
  assert.ok(employeeMaster!.columns.length > 0, "expected employee_master to have columns");
});

test("executeReadOnlyQuery returns real rows", async () => {
  const result = await db.executeReadOnlyQuery("SELECT * FROM pers.employee_master");
  assert.ok(result.rowCount > 0, "expected at least one employee row");
  assert.ok(result.columns.length > 0, "expected columns to be returned");
});

test("executeReadOnlyQuery rejects a write attempt before touching the database", async () => {
  await assert.rejects(
    () => db.executeReadOnlyQuery("DELETE FROM pers.employee_master"),
    UnsafeSqlError
  );
});

test("executeReadOnlyQuery caps unbounded queries with a LIMIT", async () => {
  const result = await db.executeReadOnlyQuery("SELECT * FROM pers.employee_master");
  assert.ok(result.rowCount <= 200, "expected default row LIMIT of 200 to be applied");
});

test.after(async () => {
  await db.close();
});
