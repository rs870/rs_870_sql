import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeSelect, assertConfirmedDml, classifySql, withRowLimit, UnsafeSqlError } from "./sqlGuard";

test("assertSafeSelect accepts a plain SELECT", () => {
  assert.doesNotThrow(() => assertSafeSelect("SELECT * FROM pers.employee_master"));
});

test("assertSafeSelect accepts a WITH ... SELECT", () => {
  assert.doesNotThrow(() =>
    assertSafeSelect("WITH recent AS (SELECT 1) SELECT * FROM recent")
  );
});

test("assertSafeSelect rejects DELETE", () => {
  assert.throws(() => assertSafeSelect("DELETE FROM pers.employee_master"), UnsafeSqlError);
});

test("assertSafeSelect rejects INSERT/UPDATE/DROP/etc", () => {
  for (const sql of [
    "INSERT INTO t VALUES (1)",
    "UPDATE t SET x = 1",
    "DROP TABLE t",
    "ALTER TABLE t ADD COLUMN x int",
    "TRUNCATE t",
    "CREATE TABLE t (x int)",
    "GRANT SELECT ON t TO foo",
  ]) {
    assert.throws(() => assertSafeSelect(sql), UnsafeSqlError, `expected rejection for: ${sql}`);
  }
});

test("assertSafeSelect rejects multiple statements", () => {
  assert.throws(
    () => assertSafeSelect("SELECT 1; DELETE FROM pers.employee_master"),
    UnsafeSqlError
  );
});

test("assertSafeSelect allows a single trailing semicolon", () => {
  assert.doesNotThrow(() => assertSafeSelect("SELECT * FROM pers.employee_master;"));
});

test("assertSafeSelect rejects non-SELECT statements that don't match forbidden keywords", () => {
  assert.throws(() => assertSafeSelect("EXPLAIN SELECT 1"), UnsafeSqlError);
});

test("withRowLimit adds a LIMIT when missing", () => {
  assert.equal(withRowLimit("SELECT * FROM t"), "SELECT * FROM t\nLIMIT 200");
});

test("withRowLimit respects a custom limit", () => {
  assert.equal(withRowLimit("SELECT * FROM t", 5), "SELECT * FROM t\nLIMIT 5");
});

test("withRowLimit does not duplicate an existing LIMIT", () => {
  assert.equal(withRowLimit("SELECT * FROM t LIMIT 10"), "SELECT * FROM t LIMIT 10");
});

test("withRowLimit strips a trailing semicolon before checking/adding LIMIT", () => {
  assert.equal(withRowLimit("SELECT * FROM t;"), "SELECT * FROM t\nLIMIT 200");
});

test("classifySql marks a plain SELECT as safe-select", () => {
  assert.equal(classifySql("SELECT * FROM pers.employee_master"), "safe-select");
});

test("classifySql marks a WITH ... SELECT as safe-select", () => {
  assert.equal(classifySql("WITH recent AS (SELECT 1) SELECT * FROM recent"), "safe-select");
});

test("classifySql marks INSERT/UPDATE/DELETE as modifying-dml", () => {
  for (const sql of ["DELETE FROM t WHERE id = 1", "UPDATE t SET x = 1", "INSERT INTO t VALUES (1)"]) {
    assert.equal(classifySql(sql), "modifying-dml", `expected modifying-dml for: ${sql}`);
  }
});

test("classifySql marks DDL as blocked-ddl, never modifying-dml", () => {
  for (const sql of ["DROP TABLE t", "ALTER TABLE t ADD COLUMN x int", "TRUNCATE t", "CREATE TABLE t (x int)", "GRANT SELECT ON t TO foo"]) {
    assert.equal(classifySql(sql), "blocked-ddl", `expected blocked-ddl for: ${sql}`);
  }
});

test("classifySql marks multiple statements as multi-statement regardless of content", () => {
  assert.equal(classifySql("SELECT 1; DELETE FROM t"), "multi-statement");
});

test("assertConfirmedDml accepts a single DELETE/UPDATE/INSERT", () => {
  assert.doesNotThrow(() => assertConfirmedDml("DELETE FROM t WHERE id = 1"));
  assert.doesNotThrow(() => assertConfirmedDml("UPDATE t SET x = 1 WHERE id = 1"));
  assert.doesNotThrow(() => assertConfirmedDml("INSERT INTO t (x) VALUES (1)"));
});

test("assertConfirmedDml rejects DDL even though it looks 'confirmable'", () => {
  assert.throws(() => assertConfirmedDml("DROP TABLE t"), UnsafeSqlError);
});

test("assertConfirmedDml rejects a SELECT (nothing to confirm)", () => {
  assert.throws(() => assertConfirmedDml("SELECT * FROM t"), UnsafeSqlError);
});

test("assertConfirmedDml rejects multiple statements", () => {
  assert.throws(() => assertConfirmedDml("DELETE FROM t; DROP TABLE t"), UnsafeSqlError);
});
