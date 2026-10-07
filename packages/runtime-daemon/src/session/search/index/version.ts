// The full-text index's version: every trigger that writes the index adds one to it in the same
// write, so two reads that see the same version see the same index, rank for rank.

import type { Database, Statement } from "better-sqlite3";

const INDEX_VERSION_SQL = "SELECT version FROM session_search_index_version";

/** Reads the full-text index's version on one connection. */
export class SearchIndexVersion {
  readonly #version: Statement<[], number>;

  constructor(reader: Database) {
    this.#version = reader.prepare<[], number>(INDEX_VERSION_SQL).pluck();
  }

  /** The version the connection's current read sees. */
  read(): number {
    const version = this.#version.get();
    if (version === undefined) {
      throw new Error("The search index's version row is missing");
    }
    return version;
  }
}
