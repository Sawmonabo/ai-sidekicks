// An error thrown on one thread and rethrown on another. A thread boundary keeps only plain data,
// so an error travels as its message, stack and SQLite code, and a SQLite error comes back as
// better-sqlite3's own class, so a caller can still test its code. Nothing here loads more than
// better-sqlite3, so a thread that only reads the database stays small.

import Database from "better-sqlite3";

/** An error carried across a thread boundary as plain data. */
export interface CarriedError {
  readonly message: string;
  readonly stack: string | undefined;
  /** The SQLite result code, present when SQLite raised it. */
  readonly sqliteCode: string | undefined;
}

/** Carries a thrown value across a thread boundary. */
export function carryError(error: unknown): CarriedError {
  if (!(error instanceof Error)) {
    return { message: String(error), stack: undefined, sqliteCode: undefined };
  }
  const code: unknown = "code" in error ? error.code : undefined;
  return {
    message: error.message,
    stack: error.stack,
    sqliteCode: typeof code === "string" && code.startsWith("SQLITE_") ? code : undefined,
  };
}

/** The error a carried one was, as a `SqliteError` with its code when SQLite raised it. */
export function rebuildError(carried: CarriedError): Error {
  const error =
    carried.sqliteCode === undefined
      ? new Error(carried.message)
      : new Database.SqliteError(carried.message, carried.sqliteCode);
  if (carried.stack !== undefined) {
    error.stack = carried.stack;
  }
  return error;
}
