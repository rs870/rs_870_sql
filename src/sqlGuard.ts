const MODIFYING_DML_KEYWORDS = /\b(INSERT|UPDATE|DELETE)\b/i;
const BLOCKED_DDL_KEYWORDS = /\b(DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|EXECUTE|CALL|COPY|VACUUM|MERGE)\b/i;
const FORBIDDEN_KEYWORDS = new RegExp(
  `${MODIFYING_DML_KEYWORDS.source}|${BLOCKED_DDL_KEYWORDS.source}`,
  "i"
);

export class UnsafeSqlError extends Error {}

export type SqlClassification = "safe-select" | "modifying-dml" | "blocked-ddl" | "multi-statement";

/**
 * Classifies a generated query before it's ever run, so the route layer can
 * decide what to do with it:
 *  - "safe-select": runs immediately, read-only, no confirmation needed.
 *  - "modifying-dml": a real INSERT/UPDATE/DELETE -- requires an admin
 *    password via POST /ask/confirm before it's ever executed for real.
 *  - "blocked-ddl": schema-altering statements (DROP/ALTER/TRUNCATE/...) --
 *    always rejected, no password can unlock these.
 *  - "multi-statement": more than one statement -- always rejected.
 */
export function classifySql(sql: string): SqlClassification {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.includes(";")) return "multi-statement";
  if (BLOCKED_DDL_KEYWORDS.test(trimmed)) return "blocked-ddl";
  if (MODIFYING_DML_KEYWORDS.test(trimmed) && !/^(SELECT|WITH)\b/i.test(trimmed)) return "modifying-dml";
  if (/^(SELECT|WITH)\b/i.test(trimmed) && !FORBIDDEN_KEYWORDS.test(trimmed)) return "safe-select";
  return "blocked-ddl";
}

/**
 * Validates a query that's already been through the admin-password check in
 * POST /ask/confirm. Only a single, real INSERT/UPDATE/DELETE statement is
 * accepted -- DDL is never allowed here even with a valid password.
 */
export function assertConfirmedDml(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (trimmed.includes(";")) {
    throw new UnsafeSqlError("Multiple statements are not allowed.");
  }
  if (BLOCKED_DDL_KEYWORDS.test(trimmed)) {
    throw new UnsafeSqlError("DDL statements can never be confirmed, regardless of password.");
  }
  if (!MODIFYING_DML_KEYWORDS.test(trimmed)) {
    throw new UnsafeSqlError("Only INSERT/UPDATE/DELETE statements go through confirmation.");
  }
}

/**
 * Rejects anything that isn't a single, read-only SELECT statement.
 * The LLM only ever proposes SQL; this is the actual trust boundary.
 */
export function assertSafeSelect(sql: string): void {
  const trimmed = sql.trim().replace(/;+\s*$/, "");

  if (trimmed.includes(";")) {
    throw new UnsafeSqlError("Multiple statements are not allowed.");
  }
  if (!/^(SELECT|WITH)\b/i.test(trimmed)) {
    throw new UnsafeSqlError("Only SELECT queries are allowed.");
  }
  if (FORBIDDEN_KEYWORDS.test(trimmed)) {
    throw new UnsafeSqlError("Query contains a forbidden keyword.");
  }
}

/** Adds a LIMIT if the query doesn't already have one, to bound result size. */
export function withRowLimit(sql: string, limit = 200): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (/\bLIMIT\s+\d+\s*$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}\nLIMIT ${limit}`;
}
