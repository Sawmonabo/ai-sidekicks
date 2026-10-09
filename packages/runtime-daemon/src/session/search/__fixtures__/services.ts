// The search thread's services over a test database file and an index folder of their own, with
// each durable commit's outbox rows deleted as the daemon's writer deletes them, so a test writes
// rows, settles the index and searches as the daemon does, and can restart it on the same folder.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Database } from "better-sqlite3";

import type { DatabaseWriter } from "../../../database/writer.js";
import { openDatabase } from "../../migration-runner.js";
import { deleteAppliedOutbox } from "../index/outbox.js";
import { openSearchServices, type SearchServices } from "../thread/services.js";

/** A test database, its search index and the services over both. */
export class SearchFixture {
  /** The test's read-write connection, which the services read on too. */
  readonly database: Database;
  readonly indexFolderPath: string;
  /** Whether a durable commit deletes the outbox rows it holds; off, as a crash before a delete. */
  isDeletingApplied = true;

  readonly #folder: string;
  readonly #databasePath: string;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #deletes: Promise<void>[] = [];
  #services: SearchServices | undefined;

  private constructor(folder: string) {
    this.#folder = folder;
    this.#databasePath = join(folder, "daemon.db");
    this.database = openDatabase(this.#databasePath);
    this.indexFolderPath = join(folder, "search-index");
    this.#writer = statementWriterOf(this.database);
  }

  /** A fresh database in a folder of its own, and the services over it. */
  static async open(): Promise<SearchFixture> {
    const fixture = new SearchFixture(await mkdtemp(join(tmpdir(), "search-index-")));
    await fixture.#open();
    return fixture;
  }

  /** The services as last opened. */
  services(): SearchServices {
    if (this.#services === undefined) {
      throw new Error("The search services are closed.");
    }
    return this.#services;
  }

  /** Applies what the writes since the last settle left in the outbox, and deletes what it held. */
  async settle(): Promise<void> {
    await this.services().applyWaiting();
    await this.#settleDeletes();
  }

  /**
   * Closes the services and opens them again on the same folder, as a daemon's restart does, with
   * `whileClosed` run between.
   */
  async reopen(whileClosed?: () => Promise<void> | void): Promise<SearchServices> {
    await this.#close();
    await whileClosed?.();
    return this.#open();
  }

  /** Closes the services and the database and removes the folder. */
  async close(): Promise<void> {
    await this.#close();
    this.database.close();
    await rm(this.#folder, { recursive: true, force: true });
  }

  async #open(): Promise<SearchServices> {
    const services = await openSearchServices({
      reader: this.database,
      databasePath: this.#databasePath,
      indexFolderPath: this.indexFolderPath,
      onApplied: (applied) => {
        if (this.isDeletingApplied) {
          this.#deletes.push(deleteAppliedOutbox(this.#writer, applied));
        }
      },
      // A test closes the services only once they have opened.
      signal: new AbortController().signal,
    });
    this.#services = services;
    await this.#settleDeletes();
    return services;
  }

  async #close(): Promise<void> {
    await this.#services?.close();
    this.#services = undefined;
    await this.#settleDeletes();
  }

  async #settleDeletes(): Promise<void> {
    await Promise.all(this.#deletes.splice(0));
  }
}

// The writer's `write`, run at once on the test's connection.
function statementWriterOf(database: Database): Pick<DatabaseWriter, "write"> {
  return {
    write: (statements) =>
      Promise.resolve(
        database.transaction(() =>
          statements.map(({ sql, bindings }) => {
            const statement = database.prepare(sql);
            const { changes } =
              bindings === undefined
                ? statement.run()
                : Array.isArray(bindings)
                  ? statement.run(...(bindings as unknown[]))
                  : statement.run(bindings);
            return { rowCount: changes, rows: [] };
          }),
        )(),
      ),
  };
}
