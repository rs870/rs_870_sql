import { test } from "node:test";
import assert from "node:assert/strict";
import "dotenv/config";
import * as db from "./db";
import { generateSql } from "./llm/generateSql";
import { classifySql } from "./sqlGuard";

/**
 * Gold-set regression suite: 20 English questions, each paired with a
 * hand-written SQL query whose result was verified directly against the
 * live `nextgendb` restore and is checked in here as ground truth.
 *
 * This file is deliberately NOT matched by `npm test`'s glob
 * (`src/**\/*.test.ts`) -- it's a slower, standing check to run by hand
 * after a change, not part of the fast everyday loop:
 *
 *   npm run test:goldset               -- ground truth only (fast, DB-only)
 *   RUN_GOLDSET_LLM=1 npm run test:goldset   -- full pipeline, English
 *                                              question -> generateSql() ->
 *                                              execute, checked against the
 *                                              same ground truth (slow, one
 *                                              live model call per question)
 */

interface GoldEntry {
  id: number;
  question: string;
  goldSql: string;
  expect: (result: db.QueryResult) => void;
}

function scalar(result: db.QueryResult): unknown {
  return Object.values(result.rows[0])[0];
}

/** node-postgres parses DATE columns into a Date built from local getters, so format it back the same way -- round-tripping through toISOString() would shift by a day in negative-UTC-offset timezones. */
function formatDate(value: unknown): string {
  const d = value as Date;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const GOLD_SET: GoldEntry[] = [
  {
    id: 1,
    question: "How many employees are there in total?",
    goldSql: "SELECT COUNT(*) FROM pers.employee_master",
    expect: (r) => assert.equal(Number(scalar(r)), 1081),
  },
  {
    id: 2,
    question: "How many active employees are there?",
    goldSql: "SELECT COUNT(*) FROM pers.employee_master WHERE is_active = true",
    expect: (r) => assert.equal(Number(scalar(r)), 965),
  },
  {
    id: 3,
    question: "How many male employees are there?",
    goldSql: "SELECT COUNT(*) FROM pers.employee_master WHERE gender = 'Male'",
    expect: (r) => assert.equal(Number(scalar(r)), 538),
  },
  {
    id: 4,
    question: "How many female employees are there?",
    goldSql: "SELECT COUNT(*) FROM pers.employee_master WHERE gender = 'Female'",
    expect: (r) => assert.equal(Number(scalar(r)), 532),
  },
  {
    id: 5,
    question: "List the 5 most recently added employees",
    goldSql:
      "SELECT name FROM pers.employee_master ORDER BY date_of_joining_org DESC NULLS LAST, user_id DESC LIMIT 5",
    expect: (r) =>
      assert.deepEqual(r.rows.map((row) => row.name), [
        "Manoj Shukla",
        "Tushar Sharma",
        "Arjun Gupta",
        "Lakshmi Menon",
        "Kavya Gupta",
      ]),
  },
  {
    id: 6,
    question: "How many employees joined in 2024?",
    goldSql: "SELECT COUNT(*) FROM pers.employee_master WHERE EXTRACT(YEAR FROM date_of_joining_org) = 2024",
    expect: (r) => assert.equal(Number(scalar(r)), 78),
  },
  {
    id: 7,
    question: "What is the earliest date of joining recorded?",
    goldSql: "SELECT MIN(date_of_joining_org) FROM pers.employee_master",
    expect: (r) => assert.equal(formatDate(scalar(r)), "1990-01-23"),
  },
  {
    id: 8,
    question: "What is the most common blood group among employees?",
    goldSql:
      "SELECT blood_group, COUNT(*) c FROM pers.employee_master GROUP BY blood_group ORDER BY c DESC NULLS LAST LIMIT 1",
    expect: (r) => assert.equal(Number(r.rows[0].c), 155),
  },
  {
    id: 9,
    question: "How many distinct blood groups are recorded?",
    goldSql: "SELECT COUNT(DISTINCT blood_group) FROM pers.employee_master WHERE blood_group IS NOT NULL",
    expect: (r) => assert.equal(Number(scalar(r)), 8),
  },
  {
    id: 10,
    question: "How many employees have a PAN number recorded?",
    goldSql: "SELECT COUNT(*) FROM pers.employee_master WHERE pan_no IS NOT NULL",
    expect: (r) => assert.equal(Number(scalar(r)), 1066),
  },
  {
    id: 11,
    question: "How many education records are there in total?",
    goldSql: "SELECT COUNT(*) FROM pers.education",
    expect: (r) => assert.equal(Number(scalar(r)), 5),
  },
  {
    id: 12,
    question: "How many employees have at least one award?",
    goldSql: "SELECT COUNT(DISTINCT user_id) FROM pers.awards",
    expect: (r) => assert.equal(Number(scalar(r)), 95),
  },
  {
    id: 13,
    question: "How many active awards are recorded?",
    goldSql: "SELECT COUNT(*) FROM pers.awards WHERE is_active = true",
    expect: (r) => assert.equal(Number(scalar(r)), 103),
  },
  {
    id: 14,
    question: "How many admonishment records exist?",
    goldSql: "SELECT COUNT(*) FROM pers.admonishments",
    expect: (r) => assert.equal(Number(scalar(r)), 0),
  },
  {
    id: 15,
    question: "How many distinct admonishment severities are there?",
    goldSql: "SELECT COUNT(DISTINCT severity) FROM pers.admonishments WHERE severity IS NOT NULL",
    expect: (r) => assert.equal(Number(scalar(r)), 0),
  },
  {
    id: 16,
    question: "How many family members are marked as currently dependent?",
    goldSql: "SELECT COUNT(*) FROM pers.family_info WHERE is_currently_dependent = true",
    expect: (r) => assert.equal(Number(scalar(r)), 173),
  },
  {
    id: 17,
    question: "How many contact records are active?",
    goldSql: "SELECT COUNT(*) FROM pers.contact WHERE is_active = true",
    expect: (r) => assert.equal(Number(scalar(r)), 55),
  },
  {
    id: 18,
    question: "How many training courses are in the training master list?",
    goldSql: "SELECT COUNT(*) FROM training.training_master",
    expect: (r) => assert.equal(Number(scalar(r)), 82),
  },
  {
    id: 19,
    question: "How many user training mappings are marked active?",
    goldSql: "SELECT COUNT(*) FROM training.user_training_mapping WHERE is_active = true",
    expect: (r) => assert.equal(Number(scalar(r)), 1511),
  },
  {
    id: 20,
    question: "How many distinct current designations are there among employees?",
    goldSql: "SELECT COUNT(DISTINCT current_designation) FROM pers.employee_master WHERE current_designation IS NOT NULL",
    expect: (r) => assert.equal(Number(scalar(r)), 67),
  },
];

for (const entry of GOLD_SET) {
  test(`gold #${entry.id} ground truth: ${entry.question}`, async () => {
    const result = await db.executeReadOnlyQuery(entry.goldSql);
    entry.expect(result);
  });
}

if (process.env.RUN_GOLDSET_LLM) {
  for (const entry of GOLD_SET) {
    test(`gold #${entry.id} full pipeline: ${entry.question}`, async () => {
      const tables = await db.listTables();
      const generated = await generateSql(entry.question, db.dialect, tables, undefined, process.env.GOLDSET_MODEL_ID);
      assert.equal(classifySql(generated.sql), "safe-select", `model produced non-SELECT SQL: ${generated.sql}`);
      const result = await db.executeReadOnlyQuery(generated.sql);
      entry.expect(result);
    });
  }
}

test.after(async () => {
  await db.close();
});
