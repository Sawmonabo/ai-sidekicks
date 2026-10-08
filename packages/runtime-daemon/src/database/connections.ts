// The daemon's ways into its database: the writer, which holds the one read-write connection on its
// worker thread, and read-only connections for reads, one of them on the main thread. Every
// connection holds the same bounded page cache.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { DatabaseWriter, type DatabaseWriterOptions } from "./writer.js";

/**
 * The page cache every connection to the daemon's database holds: at most 2,000 KiB, SQLite's own
 * default. better-sqlite3 builds with 16,000 KiB, which a large purge or a full read of the session
 * list fills on each connection.
 */
export const PAGE_CACHE_SIZE_PRAGMA = "cache_size = -2000";

/** The daemon's database: reads on `reader`, every write through `writer`. */
export interface DatabaseConnections {
  /** A read-only connection; it sees each write once the writer has committed it. */
  readonly reader: DatabaseType;
  readonly writer: DatabaseWriter;
}

/**
 * Opens the writer, which creates the file with its pragmas and schema, then the read-only
 * connection. Throws what either open threw, with nothing left open; when closing the writer
 * fails too, throws an `AggregateError` of both.
 */
export async function openDatabaseConnections(
  options: DatabaseWriterOptions,
): Promise<DatabaseConnections> {
  const writer = await DatabaseWriter.open(options);
  let reader: DatabaseType;
  try {
    reader = openDatabaseReader(options.databasePath);
  } catch (openError) {
    try {
      await writer.close();
    } catch (closeError) {
      throw new AggregateError(
        [openError, closeError],
        "Opening the database's reader failed, and closing its writer after that failed too",
        { cause: closeError },
      );
    }
    throw openError;
  }
  return { reader, writer };
}

/**
 * Closes the reader, then the writer once every write taken has settled, or once `drainWithinMs`
 * has passed; resolves with the number of writes the bound left unfinished, which failed. The
 * writer goes last, so its connection's close checkpoints the write-ahead log into the file and
 * removes it.
 */
export async function closeDatabaseConnections(
  connections: DatabaseConnections,
  drainWithinMs?: number,
): Promise<number> {
  const failures: unknown[] = [];
  try {
    connections.reader.close();
  } catch (error) {
    failures.push(error);
  }
  let unfinishedCount = 0;
  try {
    unfinishedCount = await connections.writer.close(drainWithinMs);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Closing the database's connections failed twice");
  }
  return unfinishedCount;
}

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
