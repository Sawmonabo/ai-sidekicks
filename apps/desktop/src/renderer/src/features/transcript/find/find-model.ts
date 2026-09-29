// Find in this session — the matcher behind the field.
//
// The subsequence scorer shared by the palette and settings search is own-built. THE
// FIELD'S RULE IS THIS MODULE'S: find runs over the loaded rows with a match count and
// next and previous. Reaching rows before the window's head is the viewport's backward
// read, and search across sessions is a separate feature, not a widening of this.
//
// THE BOUNDARY IS A MEMBER OF THE RESULT — `searchedRowCount` — rather than a caption
// the find box remembers to add, so a find that searched what it had cannot be read as
// a statement about the whole session.
//
// WHAT IS SEARCHED. A row's `summary`, which is the human-readable line the daemon
// composed, and its `type`, which is the wire-verbatim event kind — so typing
// `rolled_back` finds the rewind and typing a filename finds the row that names
// it. The payload is deliberately NOT searched: it is an open record whose values
// can be arbitrarily large, and a substring hit inside one would rank a row a
// person cannot see the match in.

import type { TimelineRow } from "@ai-sidekicks/contracts";

/**
 * Which way a walk through the matches moves. Closed.
 *
 * Declared here because this is where the walk is, and as an `as const` with a derived
 * type like every other closed set in the transcript feature — the seam kinds, the row
 * offers, the run group lifecycles. A third direction (a find that jumps to the head)
 * is then a compile error at every consumer rather than a hunt for bare unions.
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
  /**
   * Every match, capped at `FIND_MATCH_CAP`. The walk is over these.
   */
  readonly matches: readonly FindMatch[];
  /**
   * The TRUE match count, uncapped: a count that silently equalled the cap would tell
   * a person their query is narrower than it is.
   *
   * It is not the counter's denominator, though. The walk is over `matches`, so
   * naming this as the total a position is "of" advertised results the walk can
   * never reach.
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
 * Run a query over one loaded window.
 *
 * Case-insensitive substring, deliberately not the palette's subsequence matcher:
 * `scoreSubsequence` ranks command titles a person is half-remembering, and
 * applying it to a log would match nearly every row on a three-letter query. Find
 * is a literal search over text somebody is looking at.
 *
 * An empty or whitespace-only query matches nothing rather than everything —
 * "everything" is what the transcript already shows, and a field that highlighted every
 * row the moment it was focused would be noise.
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
 * Where the walk sits before anything has been selected.
 *
 * Negative rather than `undefined` because the field renders "n of m" from the
 * same number, and a sentinel one comparison recognizes is what keeps the two
 * readings — "nothing is selected" and "the first match is selected" — from
 * collapsing into index 0.
 */
const UNSELECTED_FIND_INDEX = -1;

/**
 * Where the next or previous match sits, given where the walk is now.
 *
 * Wraps, and that is a decision rather than an accident: a find field shows
 * "3 of 17", so a wrap is visible in the counter and a person always knows they came
 * round. A walk with no counter beside it would be a jump with nothing on screen
 * explaining it, and this one has the counter.
 *
 * THE UNSELECTED STATE IS AN ENTRY, NOT A STEP. With nothing selected there is no
 * position to step FROM, so both directions ENTER the list rather than move
 * through it: forward lands on the first match and backward on the last. Applying
 * the ±1 arithmetic to the sentinel instead read the walk as standing one place
 * before the first match, which is true going forward and false going back — a
 * backward entry then landed on the second-to-last match and the last one was
 * unreachable until the walk had wrapped all the way round to it.
 *
 * Returns `undefined` only when there is nothing to walk.
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
