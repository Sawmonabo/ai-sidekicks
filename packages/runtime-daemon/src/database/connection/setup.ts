// A connection's setup: what every connection to the daemon's database holds, a read-only
// connection opened with it, and a connection closed when its setup throws. It holds nothing of the
// writer, so a thread or process that only reads loads none of it.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Applies what every connection to the daemon's database holds: a page cache of at most 2,000 KiB,
 * SQLite's own default, since better-sqlite3 builds with 16,000 KiB, which a large purge or a full
 * read of the session list fills on each connection; and a check of each b-tree page as it is first
 * read from disk, so a damaged page fails the read that meets it rather than spreading.
 */
export function applyConnectionPragmas(database: DatabaseType): void {
  database.pragma("cache_size = -2000");
  database.pragma("cell_size_check = ON");
}

/**
 * Opens a read-only handle on an existing database, set up as the writer's is. Throws when the file
 * is missing, closing the handle when its pragma throws.
 */
export function openDatabaseReader(databasePath: string): DatabaseType {
  return prepareOrClose(
    new Database(databasePath, { readonly: true, fileMustExist: true }),
    applyConnectionPragmas,
  );
}

/**
 * Runs `prepare` on a handle just opened and returns it. When `prepare` throws, the handle is
 * closed and the error rethrown; when the close fails too, both are thrown in one `AggregateError`.
 */
export function prepareOrClose(
  database: DatabaseType,
  prepare: (database: DatabaseType) => void,
): DatabaseType {
  try {
    prepare(database);
  } catch (error) {
    try {
      database.close();
    } catch (closeFailure) {
      throw new AggregateError(
        [error, closeFailure],
        "opening the database failed, and closing the half-open handle failed too",
        { cause: closeFailure },
      );
    }
    throw error;
  }
  return database;
}
