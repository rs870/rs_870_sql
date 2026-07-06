export interface DatabaseConfig {
  id: string;
  label: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
}

/**
 * Registry of databases a caller (the web UI, or an external API client
 * like IRASS) can select by id. Only one is actually wired up to a real
 * Postgres instance today (`nextgendb`); the rest are placeholders so the
 * shape exists before real connection details are available -- fill in the
 * DB2_* env vars and the entry below becomes usable without any other code
 * changes.
 */
export const AVAILABLE_DATABASES: DatabaseConfig[] = [
  {
    id: "nextgendb",
    label: "NextGen HRMS (nextgendb)",
    host: process.env.PG_HOST ?? "localhost",
    port: Number(process.env.PG_PORT ?? 5432),
    database: process.env.PG_DATABASE ?? "nextgendb",
    user: process.env.PG_USER ?? "postgres",
    password: process.env.PG_PASSWORD,
  },
  {
    id: "db2-placeholder",
    label: "Second database (not yet configured)",
    host: process.env.DB2_HOST ?? "",
    port: Number(process.env.DB2_PORT ?? 5432),
    database: process.env.DB2_DATABASE ?? "",
    user: process.env.DB2_USER ?? "",
    password: process.env.DB2_PASSWORD,
  },
];

export const DEFAULT_DATABASE_ID = process.env.DEFAULT_DATABASE_ID ?? AVAILABLE_DATABASES[0].id;

export function getDatabaseConfig(databaseId: string | undefined): DatabaseConfig {
  const id = databaseId ?? DEFAULT_DATABASE_ID;
  const found = AVAILABLE_DATABASES.find((d) => d.id === id);
  if (!found) {
    throw new Error(`Unknown database '${id}'. Available: ${AVAILABLE_DATABASES.map((d) => d.id).join(", ")}`);
  }
  if (!found.database || !found.host) {
    throw new Error(
      `Database '${found.id}' (${found.label}) has no connection configured yet -- set its DB2_* env vars.`
    );
  }
  return found;
}

export function listDatabasesForClient(): { id: string; label: string; configured: boolean }[] {
  return AVAILABLE_DATABASES.map((d) => ({
    id: d.id,
    label: d.label,
    configured: Boolean(d.database && d.host),
  }));
}
