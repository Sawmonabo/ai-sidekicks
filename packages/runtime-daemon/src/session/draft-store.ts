import type { Statement } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import type { DatabaseConnections } from "../database/connection/lifecycle.js";
import type { WriteStatement } from "../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../database/writer.js";
import { sessionExistsStatement } from "./directory/lookups.js";
import { sessionNotFound } from "./not-found.js";

const UPSERT_DRAFT_SQL = `INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, ?, ?)
  ON CONFLICT (session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`;
const DELETE_DRAFT_SQL = "DELETE FROM session_drafts WHERE session_id = ?";

/**
 * Stores each session's unsent composer draft, one `session_drafts` row per session. The last
 * write wins, so a retried save needs no key; an empty draft deletes the row, which is how Send
 * clears it.
 */
export class SessionDraftStore {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #now: () => Date;
  readonly #selectDraft: Statement<[string], { text: string }>;

  constructor(database: DatabaseConnections, now: () => Date = () => new Date()) {
    this.#writer = database.writer;
    this.#now = now;
    this.#selectDraft = database.reader.prepare(
      "SELECT text FROM session_drafts WHERE session_id = ?",
    );
  }

  /** The session's held draft, or the empty string when none is held. */
  read(sessionId: SessionId): string {
    return this.#selectDraft.get(sessionId)?.text ?? "";
  }

  /**
   * Holds `text` as the session's draft, or clears the draft when `text` is empty, and resolves
   * with when it was stored once committed. Rejects with `session.not_found` for a
   * session the daemon has no record of.
   */
  async write(sessionId: SessionId, text: string): Promise<string> {
    const updatedAt = this.#now().toISOString();
    // The existence check and the change are one write, so a purge cannot land between them.
    const change: WriteStatement =
      text === ""
        ? { sql: DELETE_DRAFT_SQL, bindings: [sessionId] }
        : { sql: UPSERT_DRAFT_SQL, bindings: [sessionId, text, updatedAt] };
    try {
      await this.#writer.write([sessionExistsStatement(sessionId), change]);
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        throw sessionNotFound(sessionId);
      }
      throw error;
    }
    return updatedAt;
  }
}
