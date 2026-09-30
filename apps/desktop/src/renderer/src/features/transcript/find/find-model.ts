// The matcher behind the find field. It runs over the loaded rows only, and
// `searchedRowCount` is part of the result so a find cannot be read as a claim about the
// whole session. It searches a row's `summary` and wire `type`, never the payload: an open
// record whose large values would produce hits the person cannot see.

import type { TimelineRow } from "@ai-sidekicks/contracts";

/**
 * Which way a walk through the matches moves. Closed, so a third direction is a compile
 * error at every consumer.
 */
export const FIND_STEP_DIRECTIONS = ["next", "previous"] as const;

/** One direction of a walk. Derived from the enumeration, never restated. */
export type FindStepDirection = (typeof FIND_STEP_DIRECTIONS)[number];

/** One row the query matched, and where. */
export interface FindMatch {
  readonly rowId: string;
  readonly sequence: number;
  /** Which field matched, so the field can say why a row is in the list. */
  readonly matchedIn: "summary" | "type";
}

/** What one query over one window produced. */
export interface FindResult {
  readonly query: string;
  /** Every match, capped at `FIND_MATCH_CAP`. The walk is over these. */
  readonly matches: readonly FindMatch[];
  /**
   * The uncapped match count, so a capped count never understates how broad the query is. Not
   * the counter's denominator: the walk is over `matches`.
   */
  readonly totalMatchCount: number;
  /** Rows the query was actually run over. */
  readonly searchedRowCount: number;
}

/** The result an empty query produces: no matches over the rows searched. */
export function emptyFindResult(searchedRowCount: number): FindResult {
  return { query: "", matches: [], totalMatchCount: 0, searchedRowCount };
}

/**
 * Runs a query over one loaded window.
 *
 * Case-insensitive literal substring, not the palette's subsequence matcher, which would match
 * nearly every row on a short query. An empty or whitespace-only query matches nothing.
 */
export function findInTranscript(rows: readonly TimelineRow[], query: string): FindResult {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return emptyFindResult(rows.length);
  }
  const needle = trimmedQuery.toLowerCase();
  const matches: FindMatch[] = [];
  let totalMatchCount = 0;

  for (const row of rows) {
    const matchedIn = matchFieldOf(row, needle);
    if (matchedIn === undefined) {
      continue;
    }
    totalMatchCount += 1;
    if (matches.length < FIND_MATCH_CAP) {
      matches.push({ rowId: row.id, sequence: row.sequence, matchedIn });
    }
  }

  return {
    query: trimmedQuery,
    matches,
    totalMatchCount,
    searchedRowCount: rows.length,
  };
}

/** Which field a row matched on, summary first because that is what a person reads. */
function matchFieldOf(row: TimelineRow, needle: string): FindMatch["matchedIn"] | undefined {
  if (row.summary.toLowerCase().includes(needle)) {
    return "summary";
  }
  if (row.type.toLowerCase().includes(needle)) {
    return "type";
  }
  return undefined;
}

/**
 * Where the walk sits before anything is selected. A sentinel, so "nothing selected" and
 * "first match selected" stay distinct.
 */
const UNSELECTED_FIND_INDEX = -1;

/**
 * Where the next or previous match sits, wrapping in both directions.
 *
 * From the unselected state both directions enter the list: next lands on the first match,
 * previous on the last. Returns `undefined` only when there is nothing to walk.
 */
export function stepFindMatch(
  result: FindResult,
  currentIndex: number,
  direction: FindStepDirection,
): { readonly index: number; readonly match: FindMatch } | undefined {
  const count = result.matches.length;
  if (count === 0) {
    return undefined;
  }
  const index =
    currentIndex <= UNSELECTED_FIND_INDEX
      ? entryIndexFor(direction, count)
      : steppedIndexFrom(currentIndex, direction, count);
  const match = result.matches[index];
  return match === undefined ? undefined : { index, match };
}

/** Where a walk that has not started enters the list from. */
function entryIndexFor(direction: FindStepDirection, count: number): number {
  return direction === "next" ? 0 : count - 1;
}

/** The next position along, wrapping in both directions. */
function steppedIndexFrom(
  currentIndex: number,
  direction: FindStepDirection,
  count: number,
): number {
  const step = direction === "next" ? 1 : -1;
  // `+ count` before the modulus: JavaScript's `%` keeps the sign of the dividend,
  // so stepping back from index 0 would land on -1 rather than on the last match.
  return (((currentIndex + step) % count) + count) % count;
}
import { FIND_MATCH_CAP } from "../structure/structure-caps.js";
