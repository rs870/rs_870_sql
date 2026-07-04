import { Pool } from "pg";
import { assertSafeSelect, assertConfirmedDml, withRowLimit } from "./sqlGuard";

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
}

export const dialect = "postgres";

const pool = new Pool({
  host: process.env.PG_HOST ?? "localhost",
  port: Number(process.env.PG_PORT ?? 5432),
  database: process.env.PG_DATABASE ?? "nextgendb",
  user: process.env.PG_USER ?? "postgres",
  password: process.env.PG_PASSWORD,
  statement_timeout: 10_000,
});

export async function listTables(): Promise<TableInfo[]> {
  const { rows } = await pool.query(
    `SELECT c.table_schema, c.table_name, c.column_name, c.data_type, c.is_nullable
     FROM information_schema.columns c
     WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY c.table_schema, c.table_name, c.ordinal_position`
  );

  const tables = new Map<string, TableInfo>();
  for (const row of rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    if (!tables.has(key)) {
      tables.set(key, { schema: row.table_schema, name: row.table_name, columns: [] });
    }
    tables.get(key)!.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      isNullable: row.is_nullable === "YES",
    });
  }
  return [...tables.values()];
}

export interface AnalyticsSummary {
  totalEmployees: number;
  activeEmployees: number;
  maleCount: number;
  femaleCount: number;
  distinctDesignations: number;
  tableCount: number;
  databaseName: string;
  schemas: string[];
  sample: QueryResult;
}

export async function getAnalyticsSummary(): Promise<AnalyticsSummary> {
  const [summaryRes, dbRes, schemaRes, sampleRes] = await Promise.all([
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM pers.employee_master) AS total_employees,
         (SELECT COUNT(*) FROM pers.employee_master WHERE is_active = true) AS active_employees,
         (SELECT COUNT(*) FROM pers.employee_master WHERE gender = 'Male') AS male_count,
         (SELECT COUNT(*) FROM pers.employee_master WHERE gender = 'Female') AS female_count,
         (SELECT COUNT(DISTINCT current_designation) FROM pers.employee_master WHERE current_designation IS NOT NULL) AS distinct_designations,
         (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')) AS table_count`
    ),
    pool.query(`SELECT current_database() AS name`),
    pool.query(
      `SELECT DISTINCT table_schema FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema`
    ),
    pool.query(
      `SELECT name, gender, current_designation, date_of_joining_org, is_active
       FROM pers.employee_master
       ORDER BY date_of_joining_org DESC NULLS LAST, user_id DESC
       LIMIT 5`
    ),
  ]);

  const row = summaryRes.rows[0];
  return {
    totalEmployees: Number(row.total_employees),
    activeEmployees: Number(row.active_employees),
    maleCount: Number(row.male_count),
    femaleCount: Number(row.female_count),
    distinctDesignations: Number(row.distinct_designations),
    tableCount: Number(row.table_count),
    databaseName: dbRes.rows[0].name,
    schemas: schemaRes.rows.map((r) => r.table_schema),
    sample: {
      columns: sampleRes.fields.map((f) => f.name),
      rows: sampleRes.rows.map((r) => ({
        ...r,
        // node-postgres parses DATE columns into a Date built from local
        // getters -- JSON-serializing via toISOString() shifts the date by
        // a day in positive-UTC-offset timezones, so format it back the
        // same way instead of letting res.json() call toISOString().
        date_of_joining_org: r.date_of_joining_org ? formatLocalDate(r.date_of_joining_org) : null,
      })),
      rowCount: sampleRes.rowCount ?? sampleRes.rows.length,
    },
  };
}

function formatLocalDate(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

export async function executeReadOnlyQuery(sql: string): Promise<QueryResult> {
  assertSafeSelect(sql);
  const bounded = withRowLimit(sql);

  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    const result = await client.query(bounded);
    await client.query("ROLLBACK");
    return {
      columns: result.fields.map((f) => f.name),
      rows: result.rows,
      rowCount: result.rowCount ?? result.rows.length,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Actually commits an INSERT/UPDATE/DELETE. Only ever called from
 * POST /ask/confirm, after the admin password has been checked and
 * assertConfirmedDml() has re-validated the statement server-side -- this
 * function does not trust its caller, it re-checks too.
 */
export async function executeConfirmedWrite(sql: string): Promise<QueryResult> {
  assertConfirmedDml(sql);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(sql);
    await client.query("COMMIT");
    return {
      columns: result.fields?.map((f) => f.name) ?? [],
      rows: result.rows ?? [],
      rowCount: result.rowCount ?? 0,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function close(): Promise<void> {
  await pool.end();
}
