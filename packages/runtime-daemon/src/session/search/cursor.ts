// The `session.search` cursor: which held search it continues, and where the next page starts. A
// search's later pages read what its first page held, so a cursor names that search by its id and
// a place in its order of sessions; a cursor of a search no longer held continues nothing.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/error-code";
import type { SessionSearchCursor } from "@ai-sidekicks/contracts/session/methods";
import { SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE } from "@ai-sidekicks/contracts/session/search";

import { DaemonDomainError } from "../../ipc/domain-error.js";

/**
 * Where a page starts in a held search: at a session of the search's order, past its best hits
 * when an earlier page showed some, named by the last one's index key, whose place among the
 * session's hits the held view keeps.
 */
export interface SearchPagePosition {
  readonly sessionIndex: number;
  readonly afterHitKey: number | undefined;
}

/** A cursor read back: the held search it continues, and where. */
export interface SearchCursorPosition {
  readonly snapshotId: string;
  readonly position: SearchPagePosition;
}

const COUNT = "(0|[1-9][0-9]*)";
const SNAPSHOT_ID = "([0-9a-f-]+)";
const CURSOR = new RegExp(`^${SNAPSHOT_ID}:${COUNT}(?::${COUNT})?$`, "u");

/** Writes a held search's next page position as the cursor a client passes back. */
export function encodeSearchCursor(
  snapshotId: string,
  position: SearchPagePosition,
): SessionSearchCursor {
  const afterHitKey = position.afterHitKey === undefined ? "" : `:${String(position.afterHitKey)}`;
  // A snapshot id and two safe integers run to at most 70 characters, inside the cursor's bound.
  return `${snapshotId}:${String(position.sessionIndex)}${afterHitKey}` as SessionSearchCursor;
}

/**
 * Reads a cursor back. Throws `session.search_cursor_unresolvable` for a cursor
 * {@link encodeSearchCursor} did not write.
 */
export function decodeSearchCursor(cursor: SessionSearchCursor): SearchCursorPosition {
  const parts = CURSOR.exec(cursor);
  if (parts === null) {
    throw searchCursorUnresolvable(cursor);
  }
  const [, snapshotId = "", sessionIndex = "", afterHitKey] = parts;
  return {
    snapshotId,
    position: {
      sessionIndex: Number(sessionIndex),
      afterHitKey: afterHitKey === undefined ? undefined : Number(afterHitKey),
    },
  };
}

/**
 * The refusal of a cursor that continues no search the daemon holds for this query: one it did
 * not write, one written for another query, or one whose search it has since let go.
 */
export function searchCursorUnresolvable(cursor: SessionSearchCursor): DaemonDomainError {
  return new DaemonDomainError("The search cursor does not continue a search the daemon holds.", {
    code: SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { cursor },
  });
}
