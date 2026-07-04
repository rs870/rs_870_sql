interface PgErrorLike {
  code?: string;
  detail?: string;
  hint?: string;
  position?: string;
}

/**
 * Builds the JSON error body for /ask and /ask/confirm. `error` is a short
 * human-readable message; `technicalError` is the full plaintext detail
 * (error class, message, and Postgres error code/detail/hint when present)
 * so the caller can see exactly what went wrong instead of a generic
 * "Internal Server Error".
 */
export function formatErrorResponse(err: unknown): { error: string; technicalError: string } {
  if (err instanceof Error) {
    const pgErr = err as Error & PgErrorLike;
    const lines = [`${pgErr.name}: ${pgErr.message}`];
    if (pgErr.code) lines.push(`code: ${pgErr.code}`);
    if (pgErr.detail) lines.push(`detail: ${pgErr.detail}`);
    if (pgErr.hint) lines.push(`hint: ${pgErr.hint}`);
    if (pgErr.position) lines.push(`position: ${pgErr.position}`);
    return { error: pgErr.message, technicalError: lines.join("\n") };
  }
  return { error: "Unknown error", technicalError: String(err) };
}
