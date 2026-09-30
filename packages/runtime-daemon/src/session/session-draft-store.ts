// The daemon's store of each session's unsent composer draft.
//
// One row per session in `session_drafts`. Writing a draft replaces the one held,
// and writing an empty draft deletes the row, which is how Send clears it. The last
// write wins, so a retried save needs no key. `session.read` reads the draft back.

import type { Database, Statement } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts";

import { SessionNotFoundError } from "../ipc/session-errors.js";

export class SessionDraftStore {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #sessionExists: Statement<[string]>;
  readonly #upsertDraft: Statement<[string, string, string]>;
  readonly #deleteDraft: Statement<[string]>;
  readonly #selectDraft: Statement<[string], { text: string }>;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
    this.#sessionExists = database.prepare(
      "SELECT 1 FROM session_events WHERE session_id = ? LIMIT 1",
    );
    this.#upsertDraft = database.prepare(
      `INSERT INTO session_drafts (session_id, text, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at`,
    );
    this.#deleteDraft = database.prepare("DELETE FROM session_drafts WHERE session_id = ?");
    this.#selectDraft = database.prepare("SELECT text FROM session_drafts WHERE session_id = ?");
  }

  /** The session's held draft, or the empty string when none is held. */
  read(sessionId: SessionId): string {
    return this.#selectDraft.get(sessionId)?.text ?? "";
  }

  /**
   * Holds `text` as the session's draft, or clears the draft when `text` is empty,
   * and returns when it was stored. Throws {@link SessionNotFoundError} for a session
   * the daemon has no record of.
   */
  write(sessionId: SessionId, text: string): string {
    const updatedAt = this.#now().toISOString();
    this.#database.transaction(() => {
      if (this.#sessionExists.get(sessionId) === undefined) {
        throw new SessionNotFoundError(`No session ${sessionId}.`, { sessionId });
      }
      if (text === "") {
        this.#deleteDraft.run(sessionId);
      } else {
        this.#upsertDraft.run(sessionId, text, updatedAt);
      }
    })();
    return updatedAt;
  }
}
