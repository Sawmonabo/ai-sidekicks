/**
 * Whether a thrown value is a SQLite error whose code starts with `codePrefix`
 * (`SQLITE_CONSTRAINT` matches every constraint, `SQLITE_CONSTRAINT_UNIQUE` only that one). The
 * code alone proves no conflict; callers confirm with a read of the row it implies.
 */
export function hasSqliteErrorCode(thrown: unknown, codePrefix: string): boolean {
  if (typeof thrown !== "object" || thrown === null || !("code" in thrown)) {
    return false;
  }
  const code: unknown = thrown.code;
  return typeof code === "string" && code.startsWith(codePrefix);
}
