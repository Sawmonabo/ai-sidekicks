// This machine's registration, one `node_trust_state` row per machine and
// owning user. Identity lives in SQLite, so `lookup` recovers it after a daemon
// restart by reading the row.

import type { Statement } from "better-sqlite3";

import type { DatabaseConnections } from "./database/connection/lifecycle.js";
import type { DatabaseWriter } from "./database/writer.js";

/** A `node_trust_state` row: one registration of a machine for its owning user. */
export interface NodeTrustStateRow {
  readonly node_id: string;
  readonly owner_user_id: string;
  readonly established_at: string;
  readonly updated_at: string;
}

/** What `register` records: the machine and the user who owns it. */
export interface RegisterNodeInput {
  readonly nodeId: string;
  readonly ownerUserId: string;
}

// A re-registration refreshes only `updated_at`; the first-seen time stays.
const UPSERT_REGISTRATION_SQL = `INSERT INTO node_trust_state (node_id, owner_user_id, established_at, updated_at)
  VALUES (@node_id, @owner_user_id, @now, @now)
  ON CONFLICT(node_id, owner_user_id) DO UPDATE SET updated_at = excluded.updated_at`;

/** Durable registration of this machine, keyed by machine and owning user. */
export class NodeRegistry {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #selectRegistrationStatement: Statement;
  readonly #now: () => string;

  constructor(database: DatabaseConnections, now: () => string = () => new Date().toISOString()) {
    this.#writer = database.writer;
    this.#now = now;
    this.#selectRegistrationStatement = database.reader.prepare(
      `SELECT node_id, owner_user_id, established_at, updated_at
         FROM node_trust_state
        WHERE node_id = ? AND owner_user_id = ?`,
    );
  }

  /** Records the machine for its owning user, or refreshes an existing one, once committed. */
  async register(input: RegisterNodeInput): Promise<void> {
    await this.#writer.write([
      {
        sql: UPSERT_REGISTRATION_SQL,
        bindings: { node_id: input.nodeId, owner_user_id: input.ownerUserId, now: this.#now() },
      },
    ]);
  }

  /** Reads the registration; `undefined` when the machine is not registered for that user. */
  lookup(nodeId: string, ownerUserId: string): NodeTrustStateRow | undefined {
    return this.#selectRegistrationStatement.get(nodeId, ownerUserId) as
      | NodeTrustStateRow
      | undefined;
  }
}
