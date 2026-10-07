// The `session.search` cursor: where the next page starts. A search by words pages along the
// index's ranking, so its cursor names the session it resumes at by that session's best hit; a
// search by tag pages along a list built whole for each page, so its cursor names a place in it.

import { JsonRpcErrorCode } from "@ai-sidekicks/contracts/jsonrpc/message";
import { SessionIdSchema } from "@ai-sidekicks/contracts/session/id";
import {
  SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
  SessionSearchCursorSchema,
  type SessionSearchCursor,
} from "@ai-sidekicks/contracts/session/methods";

import { DaemonDomainError } from "../../ipc/domain-error.js";

import type { RankedSessionKey } from "./ranking.js";

/** A page of a search by words starts at a session, named by its best hit's place in the ranking. */
export interface RankedPagePosition extends RankedSessionKey {
  readonly order: "ranked";
  /** How many of the session's hits earlier pages showed. */
  readonly shownHitCount: number;
}

/** A page of a search by tag starts at a session, named by its place in the page's list. */
export interface ListedPagePosition {
  readonly order: "listed";
  readonly sessionIndex: number;
  /** How many of the session's hits earlier pages showed. */
  readonly shownHitCount: number;
}

/** Where a page starts: a session, and how many of its hits earlier pages already showed. */
export type SearchPagePosition = RankedPagePosition | ListedPagePosition;

const COUNT = "(0|[1-9][0-9]*)";
const RANKED_CURSOR = new RegExp(`^r:([^:]+):${COUNT}:([^:]+):${COUNT}$`, "u");
const LISTED_CURSOR = new RegExp(`^l:${COUNT}:${COUNT}$`, "u");

/** Writes a page position as the cursor a client passes back for the next page. */
export function encodeSearchCursor(position: SearchPagePosition): SessionSearchCursor {
  const text =
    position.order === "ranked"
      ? `r:${String(position.rank)}:${String(position.indexRowid)}:${position.sessionId}:` +
        String(position.shownHitCount)
      : `l:${String(position.sessionIndex)}:${String(position.shownHitCount)}`;
  return SessionSearchCursorSchema.parse(text);
}

/**
 * Reads the position a search by words resumes at. Throws `session.search_cursor_unresolvable`
 * for a cursor {@link encodeSearchCursor} did not write for such a search.
 */
export function decodeRankedSearchCursor(cursor: SessionSearchCursor): RankedPagePosition {
  const position = readSearchPosition(cursor);
  if (position?.order !== "ranked") {
    throw searchCursorUnresolvable(cursor);
  }
  return position;
}

/**
 * Reads the position a search by tag resumes at. Throws `session.search_cursor_unresolvable` for
 * a cursor {@link encodeSearchCursor} did not write for such a search.
 */
export function decodeListedSearchCursor(cursor: SessionSearchCursor): ListedPagePosition {
  const position = readSearchPosition(cursor);
  if (position?.order !== "listed") {
    throw searchCursorUnresolvable(cursor);
  }
  return position;
}

function readSearchPosition(cursor: SessionSearchCursor): SearchPagePosition | undefined {
  const ranked = RANKED_CURSOR.exec(cursor);
  if (ranked !== null) {
    const [, rankText = "", indexRowid = "", sessionIdText = "", shownHitCount = ""] = ranked;
    const rank = Number(rankText);
    const sessionId = SessionIdSchema.safeParse(sessionIdText);
    // A rank has exactly one spelling, the one `String` writes, so nothing else round-trips.
    return Number.isFinite(rank) && String(rank) === rankText && sessionId.success
      ? {
          order: "ranked",
          rank,
          indexRowid: Number(indexRowid),
          sessionId: sessionId.data,
          shownHitCount: Number(shownHitCount),
        }
      : undefined;
  }
  const listed = LISTED_CURSOR.exec(cursor);
  if (listed === null) {
    return undefined;
  }
  const [, sessionIndex = "", shownHitCount = ""] = listed;
  return {
    order: "listed",
    sessionIndex: Number(sessionIndex),
    shownHitCount: Number(shownHitCount),
  };
}

function searchCursorUnresolvable(cursor: SessionSearchCursor): DaemonDomainError {
  return new DaemonDomainError("The search cursor does not continue this search.", {
    code: SESSION_SEARCH_CURSOR_UNRESOLVABLE_CODE,
    jsonRpcCode: JsonRpcErrorCode.InvalidParams,
    detail: { cursor },
  });
}
