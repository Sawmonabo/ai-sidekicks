// The matcher behind the find field. It runs over every row the window holds, folded away or not,
// and searches the text a row draws, read on demand from what the window already holds: a
// person's whole message, a tool row's heading with its result chip, and a system message's line.
// While a query is set the log moves under it on every admitted event, so a held search reads only
// the rows that moved.

import { classifyTranscriptRow } from "../rows/kind.js";
import { toolRowHeadingOf, toolRowHeadingText } from "../rows/tool-heading.js";
import { userMessageTextOf } from "../rows/user-message.js";
import { type SystemMessageReading } from "../system-messages/classifier.js";
import { rowGrowthOf } from "../window/row-positions.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";

/**
 * Matches the find field ranks and offers next/previous over.
 * A one-character query matches most of the window; the cap keeps the next/previous walk
 * terminating, and the true match count rides beside the capped denominator.
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

/**
 * One query's result over the rows the window holds, held across the lists it is handed. A list
 * that only grew at its end, its earlier rows projected again with what find reads unchanged,
 * costs its new rows; any other list is searched whole.
 */
export class FindMatchList {
  #rows: readonly ProjectedTranscriptRow[] = [];
  #systemMessageByRowId: ReadonlyMap<string, SystemMessageReading> = new Map();
  #result: FindResult = emptyFindResult(0);

  /**
   * The result of `query` over `rows`, exactly as `findInTranscript` answers it. A row both lists
   * hold is read against the system messages of the pass that last read it, so an append reads
   * only the rows it added or replaced.
   */
  public resultOf(
    rows: readonly ProjectedTranscriptRow[],
    query: string,
    systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
  ): FindResult {
    const trimmedQuery = query.trim();
    if (rows === this.#rows && trimmedQuery === this.#result.query) {
      return this.#result;
    }
    const grown =
      trimmedQuery.length > 0 && trimmedQuery === this.#result.query
        ? this.#grownResult(rows, systemMessageByRowId)
        : undefined;
    this.#rows = rows;
    this.#systemMessageByRowId = systemMessageByRowId;
    this.#result = grown ?? findInTranscript(rows, query, systemMessageByRowId);
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
    const appendedMatches: FindMatch[] = [];
    let totalMatchCount = held.totalMatchCount;
    for (let position = growth.appendedFrom; position < rows.length; position += 1) {
      const row = rows[position] as ProjectedTranscriptRow;
      if (!rowMatches(row, needle, systemMessageByRowId)) {
        continue;
      }
      totalMatchCount += 1;
      if (held.matches.length + appendedMatches.length < FIND_MATCH_CAP) {
        appendedMatches.push({ rowId: row.id, sequence: row.sequence });
      }
    }
    return {
      query: held.query,
      // A copy of at most the capped list, so the result published before stays as it was.
      matches: appendedMatches.length === 0 ? held.matches : [...held.matches, ...appendedMatches],
      totalMatchCount,
      searchedRowCount: rows.length,
    };
  }
}

/**
 * Runs a query over the rows one window holds.
 *
 * Case-insensitive literal substring, not the palette's subsequence matcher, which would match
 * nearly every row on a short query. An empty or whitespace-only query matches nothing.
 */
export function findInTranscript(
  rows: readonly ProjectedTranscriptRow[],
  query: string,
  systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
): FindResult {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return emptyFindResult(rows.length);
  }
  const needle = trimmedQuery.toLowerCase();
  const matches: FindMatch[] = [];
  let totalMatchCount = 0;

  for (const row of rows) {
    if (!rowMatches(row, needle, systemMessageByRowId)) {
      continue;
    }
    totalMatchCount += 1;
    if (matches.length < FIND_MATCH_CAP) {
      matches.push({ rowId: row.id, sequence: row.sequence });
    }
  }

  return {
    query: trimmedQuery,
    matches,
    totalMatchCount,
    searchedRowCount: rows.length,
  };
}

/**
 * Where the next or previous match sits from `selected`, wrapping in both directions.
 *
 * With nothing selected both directions enter the list: next lands on the first match, previous
 * on the last. A selected hit whose row has left the list is stepped past by its place in the
 * log, so the walk moves on to the next live hit in that direction rather than starting over.
 * Returns `undefined` only when there is nothing to walk.
 */
export function stepFindMatch(
  result: FindResult,
  selected: FindMatch | undefined,
  direction: FindStepDirection,
): { readonly index: number; readonly match: FindMatch } | undefined {
  const count = result.matches.length;
  if (count === 0) {
    return undefined;
  }
  const index =
    selected === undefined
      ? entryIndexFor(direction, count)
      : steppedIndexFrom(result.matches, selected, direction);
  const match = result.matches[index];
  return match === undefined ? undefined : { index, match };
}

/** The result an empty query produces: no matches over the rows searched. */
function emptyFindResult(searchedRowCount: number): FindResult {
  return { query: "", matches: [], totalMatchCount: 0, searchedRowCount };
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
    return systemMessage.label;
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

/** Where a walk that has not started enters the list from. */
function entryIndexFor(direction: FindStepDirection, count: number): number {
  return direction === "next" ? 0 : count - 1;
}

/** The next position along from `selected`, wrapping in both directions. */
function steppedIndexFrom(
  matches: readonly FindMatch[],
  selected: FindMatch,
  direction: FindStepDirection,
): number {
  const count = matches.length;
  const currentIndex = matches.findIndex((match) => match.rowId === selected.rowId);
  if (currentIndex < 0) {
    return liveIndexPast(matches, selected.sequence, direction);
  }
  const step = direction === "next" ? 1 : -1;
  // `+ count` before the modulus: JavaScript's `%` keeps the sign of the dividend,
  // so stepping back from index 0 would land on -1 rather than on the last match.
  return (((currentIndex + step) % count) + count) % count;
}

/** The first live match past `sequence` in `direction`, wrapping when none lies that way. */
function liveIndexPast(
  matches: readonly FindMatch[],
  sequence: number,
  direction: FindStepDirection,
): number {
  if (direction === "next") {
    const index = matches.findIndex((match) => match.sequence > sequence);
    return index < 0 ? 0 : index;
  }
  const index = matches.findLastIndex((match) => match.sequence < sequence);
  return index < 0 ? matches.length - 1 : index;
}
