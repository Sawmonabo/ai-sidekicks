// The matcher behind the find field. It runs over every row the window holds, folded away or not,
// and searches the text a row draws, read on demand from what the window already holds: a
// person's whole message, a tool row's heading with its result chip, and a system message's line
// with the last lines a process printed under it.
// Every match is counted, and a window of them around the selection is held for the walk, which
// moves with the selection, so a step reaches every match however many there are. While a query is
// set the log moves under it on every admitted event, so a held search reads only the rows that
// moved.

import { classifyTranscriptRow } from "../rows/kind.js";
import { toolRowHeadingOf, toolRowHeadingText } from "../rows/tool-heading.js";
import { userMessageTextOf } from "../rows/user-message.js";
import { type SystemMessageReading } from "../system-messages/classifier.js";
import { rowGrowthOf } from "../window/row-positions.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/**
 * The most matches a result holds at once: a window of them around the selection, which a step
 * past either end moves. It bounds what is held, never what is counted or reached.
 */
export const FIND_MATCH_CAP = 500;

/**
 * Which way a walk through the matches moves. Closed, so a third direction is a compile
 * error at every consumer.
 */
export const FIND_STEP_DIRECTIONS = ["next", "previous"] as const;

/** One direction of a walk. Derived from the enumeration, never restated. */
export type FindStepDirection = (typeof FIND_STEP_DIRECTIONS)[number];

/** One row the query matched. */
export interface FindMatch {
  readonly rowId: string;
  readonly sequence: number;
}

/** What one query over one window produced. */
export interface FindResult {
  readonly query: string;
  /** At most `FIND_MATCH_CAP` consecutive matches, in log order, around the selection. */
  readonly matches: readonly FindMatch[];
  /** Where `matches[0]` stands among every match, so a held match's place is this plus its own. */
  readonly firstHeldIndex: number;
  /** Every match in the rows searched, held or not: the count's denominator. */
  readonly totalMatchCount: number;
  /** The first match, which a walk lands on past the last one and enters on going forward. */
  readonly firstMatch: FindMatch | undefined;
  /** The last match, which a walk lands on before the first one and enters on going back. */
  readonly lastMatch: FindMatch | undefined;
}

/**
 * One query's result over the rows the window holds, held across the lists it is handed. A list
 * that only grew at its end, its earlier rows projected again with what find reads unchanged,
 * costs its new rows; any other list, or a selection a step from would leave the held matches, is
 * searched whole.
 */
export class FindMatchList {
  #rows: readonly ProjectedTranscriptRow[] = [];
  #systemMessageByRowId: ReadonlyMap<string, SystemMessageReading> = new Map();
  #result: FindResult = EMPTY_FIND_RESULT;

  /**
   * The result of `query` over `rows`, holding the matches a step either way from `selected`
   * lands on. It counts what `findInTranscript` counts; its held matches may stand elsewhere,
   * since a list that grew keeps the window it held. A row both lists hold is read against the
   * system messages of the pass that last read it, so an append reads only the rows it added or
   * replaced.
   */
  public resultOf(
    rows: readonly ProjectedTranscriptRow[],
    query: string,
    systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
    selected?: FindMatch,
  ): FindResult {
    const trimmedQuery = query.trim();
    const isSameQuery = trimmedQuery === this.#result.query;
    if (isSameQuery && rows === this.#rows && holdsStepsFrom(this.#result, selected)) {
      return this.#result;
    }
    const grown =
      isSameQuery && trimmedQuery.length > 0 && rows !== this.#rows
        ? this.#grownResult(rows, systemMessageByRowId)
        : undefined;
    this.#rows = rows;
    this.#systemMessageByRowId = systemMessageByRowId;
    this.#result =
      grown !== undefined && holdsStepsFrom(grown, selected)
        ? grown
        : findInTranscript(rows, query, systemMessageByRowId, selected);
    return this.#result;
  }

  #grownResult(
    rows: readonly ProjectedTranscriptRow[],
    systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
  ): FindResult | undefined {
    const growth = rowGrowthOf(this.#rows, rows);
    if (growth === undefined) {
      return undefined;
    }
    const held = this.#result;
    const needle = held.query.toLowerCase();
    for (const position of growth.replacedPositions) {
      const previousRow = this.#rows[position] as ProjectedTranscriptRow;
      const nextRow = rows[position] as ProjectedTranscriptRow;
      if (
        previousRow.sequence !== nextRow.sequence ||
        rowMatches(previousRow, needle, this.#systemMessageByRowId) !==
          rowMatches(nextRow, needle, systemMessageByRowId)
      ) {
        return undefined;
      }
    }
    // Only a window that reaches the newest match takes the appended ones, while it has room.
    const isHeldToNewest = held.firstHeldIndex + held.matches.length === held.totalMatchCount;
    const appendedMatches: FindMatch[] = [];
    let { totalMatchCount, firstMatch, lastMatch } = held;
    for (let position = growth.appendedFrom; position < rows.length; position += 1) {
      const row = rows[position] as ProjectedTranscriptRow;
      if (!rowMatches(row, needle, systemMessageByRowId)) {
        continue;
      }
      const match = matchOf(row);
      totalMatchCount += 1;
      firstMatch ??= match;
      lastMatch = match;
      if (isHeldToNewest && held.matches.length + appendedMatches.length < FIND_MATCH_CAP) {
        appendedMatches.push(match);
      }
    }
    return {
      query: held.query,
      // A copy of at most the capped list, so the result published before stays as it was.
      matches: appendedMatches.length === 0 ? held.matches : [...held.matches, ...appendedMatches],
      firstHeldIndex: held.firstHeldIndex,
      totalMatchCount,
      firstMatch,
      lastMatch,
    };
  }
}

/**
 * Runs a query over the rows one window holds, counting every match and holding those around
 * `selected`: up to half the cap before it and the rest from it on, or the first `FIND_MATCH_CAP`
 * with nothing selected. Rows are in the order they are drawn.
 *
 * Case-insensitive literal substring, not the palette's subsequence matcher, which would match
 * nearly every row on a short query. An empty or whitespace-only query matches nothing.
 */
export function findInTranscript(
  rows: readonly ProjectedTranscriptRow[],
  query: string,
  systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
  selected?: FindMatch,
): FindResult {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return EMPTY_FIND_RESULT;
  }
  const needle = trimmedQuery.toLowerCase();
  // The rows of the newest matches before the selection: cut back by half each time they reach the
  // cap, so a match costs the same however many come before it. Rows, so a match not held makes
  // no object.
  const rowsBefore: ProjectedTranscriptRow[] = [];
  let matchBeforeCount = 0;
  const matchesFrom: FindMatch[] = [];
  let totalMatchCount = 0;
  let firstRow: ProjectedTranscriptRow | undefined;
  let lastRow: ProjectedTranscriptRow | undefined;
  // A waiting message stands below agent rows newer than it, so a selection the rows still hold
  // splits them where it is drawn; only one that has left is placed by its sequence.
  const isSelectionHeld = selected !== undefined && rows.some((row) => row.id === selected.rowId);
  let isPastSelection = false;

  for (const row of rows) {
    isPastSelection ||= row.id === selected?.rowId;
    if (!rowMatches(row, needle, systemMessageByRowId)) {
      continue;
    }
    totalMatchCount += 1;
    firstRow ??= row;
    lastRow = row;
    if (
      selected !== undefined &&
      !isPastSelection &&
      (isSelectionHeld || row.sequence < selected.sequence)
    ) {
      matchBeforeCount += 1;
      rowsBefore.push(row);
      if (rowsBefore.length === FIND_MATCH_CAP) {
        rowsBefore.splice(0, HELD_BEFORE_SELECTION);
      }
    } else if (
      matchesFrom.length + Math.min(rowsBefore.length, HELD_BEFORE_SELECTION) <
      FIND_MATCH_CAP
    ) {
      matchesFrom.push(matchOf(row));
    }
  }

  const heldBefore = rowsBefore.slice(-HELD_BEFORE_SELECTION).map(matchOf);
  return {
    query: trimmedQuery,
    matches: [...heldBefore, ...matchesFrom],
    firstHeldIndex: matchBeforeCount - heldBefore.length,
    totalMatchCount,
    firstMatch: firstRow === undefined ? undefined : matchOf(firstRow),
    lastMatch: lastRow === undefined ? undefined : matchOf(lastRow),
  };
}

/**
 * Where the next or previous match sits from `selected`, as its place among every match, wrapping
 * in both directions.
 *
 * With nothing selected both directions enter the list: next lands on the first match, previous
 * on the last. A selected hit whose row has left the list is stepped past by its place in the
 * log, so the walk moves on to the next live hit in that direction rather than starting over.
 * Returns `undefined` when there is nothing to walk, or when `result` does not hold the match a
 * step lands on, which a result `FindMatchList` held for `selected` always does.
 */
export function stepFindMatch(
  result: FindResult,
  selected: FindMatch | undefined,
  direction: FindStepDirection,
): { readonly index: number; readonly match: FindMatch } | undefined {
  const count = result.totalMatchCount;
  if (count === 0) {
    return undefined;
  }
  let index: number;
  if (selected === undefined) {
    index = direction === "next" ? 0 : count - 1;
  } else {
    const neighbors = heldNeighborsOf(result.matches, selected);
    const heldIndex = direction === "next" ? neighbors.after : neighbors.before;
    // `+ count` before the modulus: JavaScript's `%` keeps the sign of the dividend,
    // so stepping back from the first match would land on -1 rather than on the last match.
    index = (((result.firstHeldIndex + heldIndex) % count) + count) % count;
  }
  const match = matchAt(result, index);
  return match === undefined ? undefined : { index, match };
}

/** How many matches before the selection a result holds: half the cap. */
const HELD_BEFORE_SELECTION = FIND_MATCH_CAP / 2;

/** The match a matching row makes. */
function matchOf(row: ProjectedTranscriptRow): FindMatch {
  return { rowId: row.id, sequence: row.sequence };
}

/** Whether the text a row draws holds `needle`, already lowercased. */
function rowMatches(
  row: ProjectedTranscriptRow,
  needle: string,
  systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
): boolean {
  return drawnTextOf(row, systemMessageByRowId)?.toLowerCase().includes(needle) === true;
}

/**
 * The text a row draws, read from what the window holds, or `undefined` for a row whose text the
 * window does not hold: a reply or a reasoning body.
 */
function drawnTextOf(
  row: ProjectedTranscriptRow,
  systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
): string | undefined {
  const systemMessage = systemMessageByRowId.get(row.id);
  if (systemMessage !== undefined) {
    // A system message as it is drawn: its line, and under it any last lines a process printed.
    return systemMessage.lastLines === undefined
      ? systemMessage.label
      : `${systemMessage.label}\n${systemMessage.lastLines}`;
  }
  switch (classifyTranscriptRow(row)?.kind) {
    case "user-message":
      return userMessageTextOf(row);
    case "tool-call":
      return toolRowHeadingText(toolRowHeadingOf(row, row.content));
    case "agent-message":
    case "thinking":
    case undefined:
      return undefined;
  }
}

/**
 * Where in `matches` the match before and the match after `selected` stand, either one past the
 * list's end when it holds none that way. A selected hit whose row has left is placed by its
 * sequence.
 */
function heldNeighborsOf(
  matches: readonly FindMatch[],
  selected: FindMatch,
): { readonly before: number; readonly after: number } {
  const heldIndex = matches.findIndex((match) => match.rowId === selected.rowId);
  if (heldIndex >= 0) {
    return { before: heldIndex - 1, after: heldIndex + 1 };
  }
  const laterIndex = matches.findIndex((match) => match.sequence > selected.sequence);
  const after = laterIndex < 0 ? matches.length : laterIndex;
  return { before: after - 1, after };
}

/**
 * Whether a step either way from `selected` lands on a match `result` holds: one held beside it,
 * or, past an end of every match, the first or the last.
 */
function holdsStepsFrom(result: FindResult, selected: FindMatch | undefined): boolean {
  if (selected === undefined || result.totalMatchCount === 0) {
    return true;
  }
  const { before, after } = heldNeighborsOf(result.matches, selected);
  const reachesBefore = before >= 0 || result.firstHeldIndex === 0;
  const reachesAfter =
    after < result.matches.length ||
    result.firstHeldIndex + result.matches.length === result.totalMatchCount;
  return reachesBefore && reachesAfter;
}

/** The match at `index` among every match, or `undefined` where `result` does not hold it. */
function matchAt(result: FindResult, index: number): FindMatch | undefined {
  if (index === 0) {
    return result.firstMatch;
  }
  if (index === result.totalMatchCount - 1) {
    return result.lastMatch;
  }
  return result.matches[index - result.firstHeldIndex];
}

/**
 * What an empty query finds: one object, so a log moving under an empty field changes no result.
 */
const EMPTY_FIND_RESULT: FindResult = {
  query: "",
  matches: [],
  firstHeldIndex: 0,
  totalMatchCount: 0,
  firstMatch: undefined,
  lastMatch: undefined,
};
