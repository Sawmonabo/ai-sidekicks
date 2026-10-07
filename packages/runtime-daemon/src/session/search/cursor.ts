// The `session.search` cursor: which held search it continues, and where the next page starts. A
// search's later pages read what its first page held, so a cursor names that search by its id and
// a place in its order of sessions; a cursor of a search no longer held continues nothing.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import {
  SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
  SessionSearchCursorSchema,
  type SessionSearchCursor,
} from "@ai-sidekicks/contracts/session/methods";

import { DaemonDomainError } from "../../ipc/domain-error.js";

// A page of a search with words starts at a session of the ranking's order; past its best hits
// when an earlier page showed some, named by the last one's index row, which keeps its rank.
interface RankedPagePosition {
  readonly order: "ranked";
  readonly sessionIndex: number;
  readonly afterHitRowid: number | undefined;
}

/** A page of a search by tag alone starts at a session of its list, past the hits shown. */
export interface ListedPagePosition {
  readonly order: "listed";
  readonly sessionIndex: number;
  /** How many of the session's hits earlier pages showed. */
  readonly shownHitCount: number;
}

/** Where a page starts in a held search: a session, and which of its hits earlier pages showed. */
export type SearchPagePosition = RankedPagePosition | ListedPagePosition;

/** A cursor read back: the held search it continues, and where. */
export interface SearchCursorPosition {
  readonly snapshotId: string;
  readonly position: SearchPagePosition;
}

const COUNT = "(0|[1-9][0-9]*)";
const SNAPSHOT_ID = "([0-9a-f-]+)";
const RANKED_CURSOR = new RegExp(`^r:${SNAPSHOT_ID}:${COUNT}(?::${COUNT})?$`, "u");
const LISTED_CURSOR = new RegExp(`^l:${SNAPSHOT_ID}:${COUNT}:${COUNT}$`, "u");

/** Writes a held search's next page position as the cursor a client passes back. */
export function encodeSearchCursor(
  snapshotId: string,
  position: SearchPagePosition,
): SessionSearchCursor {
  const place = String(position.sessionIndex);
  const text =
    position.order === "ranked"
      ? `r:${snapshotId}:${place}` +
        (position.afterHitRowid === undefined ? "" : `:${String(position.afterHitRowid)}`)
      : `l:${snapshotId}:${place}:${String(position.shownHitCount)}`;
  return SessionSearchCursorSchema.parse(text);
}

/**
 * Reads a cursor back. Throws `session.search_cursor_unresolvable` for a cursor
 * {@link encodeSearchCursor} did not write.
 */
export function decodeSearchCursor(cursor: SessionSearchCursor): SearchCursorPosition {
  const ranked = RANKED_CURSOR.exec(cursor);
  if (ranked !== null) {
    const [, snapshotId = "", sessionIndex = "", afterHitRowid] = ranked;
    return {
      snapshotId,
      position: {
        order: "ranked",
        sessionIndex: Number(sessionIndex),
        afterHitRowid: afterHitRowid === undefined ? undefined : Number(afterHitRowid),
      },
    };
  }
  const listed = LISTED_CURSOR.exec(cursor);
  if (listed === null) {
    throw searchCursorUnresolvable(cursor);
  }
  const [, snapshotId = "", sessionIndex = "", shownHitCount = ""] = listed;
  return {
    snapshotId,
    position: {
      order: "listed",
      sessionIndex: Number(sessionIndex),
      shownHitCount: Number(shownHitCount),
    },
  };
}

/**
 * The refusal of a cursor that continues no search the daemon holds for this query: one it did
 * not write, one written for another query, or one whose ranking it has since let go.
 */
export function searchCursorUnresolvable(cursor: SessionSearchCursor): DaemonDomainError {
  return new DaemonDomainError("The search cursor does not continue a search the daemon holds.", {
    code: SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { cursor },
  });
}
