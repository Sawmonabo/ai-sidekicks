// The daemon's two ways into its database: the writer, which holds the one read-write connection on
// its worker thread, and a read-only connection on the main thread for reads.

import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { DatabaseWriter, type DatabaseWriterOptions } from "./writer.js";

/** The daemon's database: reads on `reader`, every write through `writer`. */
export interface DatabaseConnections {
  /** A read-only connection; it sees each write once the writer has committed it. */
  readonly reader: DatabaseType;
  readonly writer: DatabaseWriter;
}

/**
 * Opens the writer, which creates the file with its pragmas and schema, then the read-only
 * connection. Throws what either open threw, with nothing left open.
 */
export async function openDatabaseConnections(
  options: DatabaseWriterOptions,
): Promise<DatabaseConnections> {
  const writer = await DatabaseWriter.open(options);
  let reader: DatabaseType;
  try {
    reader = new Database(options.databasePath, { readonly: true, fileMustExist: true });
  } catch (error) {
    await writer.close();
    throw error;
  }
  return { reader, writer };
}

/**
 * Closes the reader, then the writer once every write taken has settled. The writer goes last, so
 * its connection's close checkpoints the write-ahead log into the file and removes it.
 */
export async function closeDatabaseConnections(connections: DatabaseConnections): Promise<void> {
  const failures: unknown[] = [];
  try {
    connections.reader.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await connections.writer.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "Closing the database's connections failed twice");
  }
}
