// Find in ledger — the matcher behind the field.
//
// `Spec-023 §Console Libraries`, state-and-search row, OWN-BUILDs "the subsequence
// scorer shared by the palette, settings search, sidebar filter, and find". THE FIELD'S
// RULE IS THIS MODULE'S, because no committed document states it: find runs over the
// loaded rows with a match count and next and previous, and states its boundary in the
// field — "searched loaded rows only", beside a "load earlier" affordance. Search across
// sessions is growth, not a widening of this.
//
// THE BOUNDARY IS THE FEATURE. A find field that searched what it had and said
// nothing would let a person conclude a session does not contain something it
// does. So the boundary is a member of the result — `searchedRowCount` and
// `hasEarlierRows` — rather than a caption the surface remembers to add, and
// `LEDGER_FIND_SCOPE_NOTE` is the one sentence both the field and its test read.
//
// WHAT IS SEARCHED. A row's `summary`, which is the human-readable line the daemon
// composed, and its `type`, which is the wire-verbatim event kind — so typing
// `rolled_back` finds the rewind and typing a filename finds the row that names
// it. The payload is deliberately NOT searched: it is an open record whose values
// can be arbitrarily large, and a substring hit inside one would rank a row a
// person cannot see the match in.

import type { TimelineRow } from "@ai-sidekicks/contracts";

import { FIND_MATCH_CAP } from "../structure-bounds.js";

/**
 * The sentence the field states its boundary in.
 *
 * One string, read by the component and by the test that asserts it is shown —
 * two copies would let the field drop the caption while the test kept passing
 * against its own literal.
 */
export const LEDGER_FIND_SCOPE_NOTE = "Searched loaded rows only.";

/**
 * Which way a walk through the matches moves. Closed.
 *
 * Declared here because this is where the walk is, and declared at all because it
 * was the family's one closed set restated inline: ten bare unions across six
 * modules and two directories, in a family where every other closed set — the
 * replay states, the rail tones, the chapter lifecycles — is an `as const` with a
 * derived type. A third direction (a find that jumps to the head) would have meant
 * editing ten declarations with nothing reporting a missed one; from here it is a
 * compile error at every consumer.
 */
export const FIND_STEP_DIRECTIONS = ["next", "previous"] as const;

/** One direction of a walk. Derived from the enumeration, never restated. */
export type FindStepDirection = (typeof FIND_STEP_DIRECTIONS)[number];

/**
 * The sentence a capped walk states, beside the scope note and never instead of it.
 *
 * A different boundary from the scope note's, and the difference is why it is its
 * own string: the scope note bounds what was SEARCHED, and this bounds what can be
 * STEPPED THROUGH. Composed from `FIND_MATCH_CAP` rather than restating the number,
 * for the same one-value-one-home reason the constant carries its own rationale.
 */
export const LEDGER_FIND_CAP_NOTE: string = `Only the first ${String(FIND_MATCH_CAP)} matches can be stepped through. Narrow the query to reach the rest.`;

/** One row the query matched, and where. */
export interface LedgerFindMatch {
  readonly rowId: string;
  readonly sequence: number;
  /** Which field matched, so the field can say why a row is in the list. */
  readonly matchedIn: "summary" | "type";
}

/** What one query over one window produced. */
export interface LedgerFindResult {
  readonly query: string;
  /**
   * Every match, capped at `FIND_MATCH_CAP`. The walk is over these.
   */
  readonly matches: readonly LedgerFindMatch[];
  /**
   * The TRUE match count, uncapped. Reported honestly beside a capped walk: a
   * count that silently equalled the cap would tell a person their query is
   * narrower than it is.
   *
   * It is not the counter's denominator, though. The walk is over `matches`, so
   * naming this as the total a position is "of" advertised results the walk can
   * never reach — "500 of 700", then a wrap to "1 of 700", with 501–700 sitting
   * behind nothing on screen. It rides BESIDE the walkable figure instead.
   */
  readonly totalMatchCount: number;
  /** Rows the query was actually run over. Half of the stated boundary. */
  readonly searchedRowCount: number;
  /** Whether the session has rows before this window. The other half. */
  readonly hasEarlierRows: boolean;
}

/** The result an empty query produces: no matches, and the boundary still stated. */
export function emptyFindResult(
  searchedRowCount: number,
  hasEarlierRows: boolean,
): LedgerFindResult {
  return { query: "", matches: [], totalMatchCount: 0, searchedRowCount, hasEarlierRows };
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
 * "everything" is what the ledger already shows, and a field that highlighted every
 * row the moment it was focused would be noise.
 */
export function findInLedger(
  rows: readonly TimelineRow[],
  query: string,
  hasEarlierRows: boolean,
): LedgerFindResult {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return emptyFindResult(rows.length, hasEarlierRows);
  }
  const needle = trimmedQuery.toLowerCase();
  const matches: LedgerFindMatch[] = [];
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
    hasEarlierRows,
  };
}

/**
 * Whether the cap kept matches out of the walk.
 *
 * Derived rather than carried as a result member — the two counts already say it —
 * and read by both surfaces that have to agree about it: the counter, which names a
 * second figure only here, and the cap sentence, which is rendered only here.
 */
export function isFindWalkCapped(result: LedgerFindResult): boolean {
  return result.totalMatchCount > result.matches.length;
}

/** Which field a row matched on, summary first because that is what a person reads. */
function matchFieldOf(row: TimelineRow, needle: string): LedgerFindMatch["matchedIn"] | undefined {
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
 * same number, and a sentinel one comparison recognises is what keeps the two
 * readings — "nothing is selected" and "the first match is selected" — from
 * collapsing into index 0.
 */
const UNSELECTED_FIND_INDEX = -1;

/**
 * Where the next or previous match sits, given where the walk is now.
 *
 * Wraps, unlike the rail's tick walk, and the difference is deliberate: a find
 * field shows "3 of 17", so a wrap is visible in the counter and a person always
 * knows they came round. The rail shows no counter, so a silent wrap there would
 * be a jump with nothing on screen explaining it.
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
  result: LedgerFindResult,
  currentIndex: number,
  direction: FindStepDirection,
): { readonly index: number; readonly match: LedgerFindMatch } | undefined {
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
