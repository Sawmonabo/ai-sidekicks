// A handle on the daemon's database: the page cache every handle holds, a read-only handle opened,
// and a handle closed when its setup throws. It holds nothing of the writer, so a thread or process
// that only reads loads none of it.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

/**
 * The page cache every connection to the daemon's database holds: at most 2,000 KiB, SQLite's own
 * default. better-sqlite3 builds with 16,000 KiB, which a large purge or a full read of the session
 * list fills on each connection.
 */
export const PAGE_CACHE_SIZE_PRAGMA = "cache_size = -2000";

/**
 * Opens a read-only handle on an existing database, its page cache bounded as the writer's is.
 * Throws when the file is missing, closing the handle when its pragma throws.
 */
export function openDatabaseReader(databasePath: string): DatabaseType {
  return prepareOrClose(
    new Database(databasePath, { readonly: true, fileMustExist: true }),
    (database) => {
      database.pragma(PAGE_CACHE_SIZE_PRAGMA);
    },
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
