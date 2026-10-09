// The daemon's ways into its database: the writer, which holds the one read-write connection on its
// worker thread, and the read-only connection the main thread reads on.

import type { Database as DatabaseType } from "better-sqlite3";

import { DatabaseWriter, type DatabaseWriterOptions } from "../writer.js";
import { openDatabaseReader } from "./setup.js";

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
