// The person's `related` links: added on purpose between two sessions and the one kind a person
// removes. A pair holds at most one, whichever session it was added from.

import type { Statement } from "better-sqlite3";

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import {
  SESSION_LINK_NOT_REMOVABLE_CODE,
  type SessionLinkRequest,
} from "@ai-sidekicks/contracts/session/links";

import type { DatabaseConnections } from "../../database/connections.js";
import { WriteRefusedError, type DatabaseWriter } from "../../database/writer.js";
import { DaemonDomainError } from "../../ipc/domain-error.js";
import { SessionNotFoundError } from "../../ipc/session-errors.js";
import { sessionExistsStatement } from "../groups/store.js";
import type { SessionRelatedRanking } from "../related/ranking.js";

const ADD_RELATED_LINK_SQL = `INSERT INTO session_links
    (source_session_id, target_session_id, kind, use_count, first_at, last_at)
  SELECT @sessionId, @targetSessionId, 'related', 1, @now, @now
   WHERE NOT EXISTS (SELECT 1 FROM session_links
                      WHERE source_session_id = @targetSessionId
                        AND target_session_id = @sessionId
                        AND kind = 'related')
  ON CONFLICT (source_session_id, target_session_id, kind) DO NOTHING`;

const REMOVE_RELATED_LINK_SQL = `DELETE FROM session_links
  WHERE kind = 'related'
    AND ((source_session_id = @sessionId AND target_session_id = @targetSessionId)
      OR (source_session_id = @targetSessionId AND target_session_id = @sessionId))`;

const PAIR_HAS_LINK_SQL = `SELECT 1 FROM session_links
  WHERE (source_session_id = @sessionId AND target_session_id = @targetSessionId)
     OR (source_session_id = @targetSessionId AND target_session_id = @sessionId)
  LIMIT 1`;

// The positions of the guards in a link write.
const SESSION_GUARD_INDEX = 0;
const TARGET_GUARD_INDEX = 1;

/** What the link service needs from the daemon. */
export interface SessionLinkServiceOptions {
  readonly reader: DatabaseConnections["reader"];
  readonly writer: Pick<DatabaseWriter, "write">;
  /** Re-scores the two sessions' related lists once a change commits. */
  readonly relatedRanking: Pick<SessionRelatedRanking, "rescoreAround">;
  readonly now?: () => Date;
}

/** Adds and removes the `related` link between two sessions. */
export class SessionLinkService {
  readonly #selectPairLink: Statement<{ sessionId: string; targetSessionId: string }, unknown>;
  readonly #writer: Pick<DatabaseWriter, "write">;
  readonly #relatedRanking: Pick<SessionRelatedRanking, "rescoreAround">;
  readonly #now: () => Date;

  constructor(options: SessionLinkServiceOptions) {
    this.#selectPairLink = options.reader.prepare(PAIR_HAS_LINK_SQL);
    this.#writer = options.writer;
    this.#relatedRanking = options.relatedRanking;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Links the two sessions as related; a pair already related stays as it is. Rejects with
   * {@link SessionNotFoundError} when either session is unknown, and with `invalid_params` for a
   * session linked to itself.
   */
  async add(request: SessionLinkRequest): Promise<void> {
    if (request.sessionId === request.targetSessionId) {
      throw new DaemonDomainError("A session cannot be linked to itself.", {
        code: "invalid_params",
        jsonRpcCode: JsonRpcErrorCode.InvalidParams,
        detail: { sessionId: request.sessionId },
      });
    }
    const now = this.#now().toISOString();
    const results = await this.#writeForPair(request, {
      sql: ADD_RELATED_LINK_SQL,
      bindings: { sessionId: request.sessionId, targetSessionId: request.targetSessionId, now },
    });
    if (results.at(-1)?.rowCount === 1) {
      this.#relatedRanking.rescoreAround([request.sessionId, request.targetSessionId]);
    }
  }

  /**
   * Removes the pair's `related` link, from either side. Rejects with
   * `session.link_not_removable` when the pair is linked only by kinds an event recorded, and with
   * {@link SessionNotFoundError} for an unknown session; a pair with no link is left as it is.
   */
  async remove(request: SessionLinkRequest): Promise<void> {
    const pair = { sessionId: request.sessionId, targetSessionId: request.targetSessionId };
    const results = await this.#writeForPair(request, {
      sql: REMOVE_RELATED_LINK_SQL,
      bindings: pair,
    });
    if (results.at(-1)?.rowCount === 1) {
      this.#relatedRanking.rescoreAround([request.sessionId, request.targetSessionId]);
      return;
    }
    // Nothing was written, so this read decides only which answer the person gets.
    if (this.#selectPairLink.get(pair) !== undefined) {
      throw new DaemonDomainError("This link records what happened and stays.", {
        code: SESSION_LINK_NOT_REMOVABLE_CODE,
        detail: pair,
      });
    }
  }

  // Runs `change` in one write behind both sessions' existence guards.
  async #writeForPair(
    request: SessionLinkRequest,
    change: { readonly sql: string; readonly bindings: Readonly<Record<string, unknown>> },
  ): ReturnType<DatabaseWriter["write"]> {
    try {
      return await this.#writer.write([
        sessionExistsStatement(request.sessionId),
        sessionExistsStatement(request.targetSessionId),
        change,
      ]);
    } catch (error) {
      if (error instanceof WriteRefusedError) {
        if (error.statementIndex === SESSION_GUARD_INDEX) {
          throw sessionNotFound(request.sessionId);
        }
        if (error.statementIndex === TARGET_GUARD_INDEX) {
          throw sessionNotFound(request.targetSessionId);
        }
      }
      throw error;
    }
  }
}

function sessionNotFound(sessionId: SessionId): Error {
  return new SessionNotFoundError(`No session ${sessionId}.`, { sessionId });
}
