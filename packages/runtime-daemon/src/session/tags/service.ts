// A session's tags: any number per session, across projects, kept as written and matched on their
// case fold, so `Billing` and `billing` are one tag.

import type { Statement } from "better-sqlite3";

import { foldName } from "@ai-sidekicks/contracts/name-fold";
import type {
  SessionTagListResponse,
  SessionTagRequest,
} from "@ai-sidekicks/contracts/session/tags";

import type { DatabaseConnections } from "../../database/connections.js";
import type { WriteStatement } from "../../database/statement.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { sessionExistsStatement } from "../directory/lookups.js";
import { sessionNotFound } from "../not-found.js";

// A tag the session already holds under another casing keeps the casing it was first written in.
const ADD_TAG_SQL = `INSERT INTO session_tags (session_id, tag, tag_folded)
  VALUES (@sessionId, @tag, @tagFolded)
  ON CONFLICT (session_id, tag_folded) DO NOTHING`;

const REMOVE_TAG_SQL =
  "DELETE FROM session_tags WHERE session_id = @sessionId AND tag_folded = @tagFolded";

// One spelling per tag in use, in the fold's order.
const TAGS_IN_USE_SQL =
  "SELECT MIN(tag) AS tag FROM session_tags GROUP BY tag_folded ORDER BY tag_folded";

/** Adds, removes and lists session tags. */
export class SessionTagService {
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #selectTagsInUse: Statement<[], { readonly tag: string }>;

  constructor(database: Pick<DatabaseConnections, "reader" | "writer">) {
    this.#writer = database.writer;
    this.#selectTagsInUse = database.reader.prepare(TAGS_IN_USE_SQL);
  }

  /**
   * Tags the session; a tag it already holds, ignoring case, stays as it is. Rejects with
   * `session.not_found` for an unknown session.
   */
  async add(request: SessionTagRequest): Promise<void> {
    await this.#writeForSession(request.sessionId, {
      sql: ADD_TAG_SQL,
      bindings: {
        sessionId: request.sessionId,
        tag: request.tag,
        tagFolded: foldName(request.tag),
      },
    });
  }

  /**
   * Removes the tag from the session, matched ignoring case; a tag it does not hold is already
   * gone. Rejects with `session.not_found` for an unknown session.
   */
  async remove(request: SessionTagRequest): Promise<void> {
    await this.#writeForSession(request.sessionId, {
      sql: REMOVE_TAG_SQL,
      bindings: { sessionId: request.sessionId, tagFolded: foldName(request.tag) },
    });
  }

  /** The tags in use across every session, for `Add tag` to suggest. */
  list(): SessionTagListResponse {
    return { tags: this.#selectTagsInUse.all().map((row) => row.tag) };
  }

  async #writeForSession(sessionId: SessionTagRequest["sessionId"], change: WriteStatement) {
    try {
      await this.#writer.write([sessionExistsStatement(sessionId), change]);
    } catch (error) {
      if (error instanceof WriteRefusedError && error.statementIndex === 0) {
        throw sessionNotFound(sessionId);
      }
      throw error;
    }
  }
}
