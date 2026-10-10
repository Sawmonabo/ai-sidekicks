// The matcher behind the find field. It runs over the loaded rows only, and
// `searchedRowCount` is part of the result so a find cannot be read as a claim about the
// whole session. It searches the text a row draws, read on demand from what the window already
// holds: a person's whole message, a tool row's heading and a system message's line. While a query
// is set the log moves under it on every admitted event, so a held search reads only the rows that
// moved.

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

import { isDrawnRow } from "../feed/drawn-rows.js";
import { classifyTranscriptRow } from "../rows/kind.js";
import { type TranscriptRowRenderer } from "../rows/renderer.js";
import { toolRowHeadingOf, toolRowHeadingText } from "../rows/tool-heading.js";
import { userMessageTextOf } from "../rows/user-message.js";
import { type SystemMessageReading } from "../system-messages/classifier.js";
import { rowGrowthOf } from "../window/row-positions.js";

/**
 * Matches the find field ranks and offers next/previous over.
 * A one-character query matches most of the loaded window; the cap keeps the next/previous walk
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
 * One query's result over the rows the feed draws, held across the lists it is handed. A list that
 * only grew at its end, its earlier rows projected again with what find reads unchanged, costs its
 * new rows; any other list is searched whole.
 */
export class FindMatchList {
  #rows: readonly TranscriptEventRow[] = [];
  #systemMessageByRowId: ReadonlyMap<string, SystemMessageReading> = new Map();
  #result: FindResult = emptyFindResult(0);

  /**
   * The result of `query` over `rows`, exactly as `findInTranscript` answers it. A row both lists
   * hold is read against the system messages of the pass that last read it, so an append reads
   * only the rows it added or replaced.
   */
  public resultOf(
    rows: readonly TranscriptEventRow[],
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
    rows: readonly TranscriptEventRow[],
    systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
  ): FindResult | undefined {
    const growth = rowGrowthOf(this.#rows, rows);
    if (growth === undefined) {
      return undefined;
    }
    const held = this.#result;
    const needle = held.query.toLowerCase();
    for (const position of growth.replacedPositions) {
      const previousRow = this.#rows[position] as TranscriptEventRow;
      const nextRow = rows[position] as TranscriptEventRow;
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
      const row = rows[position] as TranscriptEventRow;
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
 * How many of the rows the run fold withholds match one query and would be drawn once their group
 * opens, held across the lists the fold reports. Both lists are in log order, so one walk of the
 * two by sequence finds the rows that joined, left or were projected again, and only those are
 * matched; a new query or a new renderer is counted whole. Whether the feed draws a row is a fact
 * about the row object, so a row both lists hold keeps its place in the count.
 */
export class FoldedMatchCount {
  #rows: readonly TranscriptEventRow[] = [];
  #needle = "";
  #systemMessageByRowId: ReadonlyMap<string, SystemMessageReading> = new Map();
  #drawsBody: TranscriptRowRenderer["drawsBody"] | undefined;
  #count = 0;

  /**
   * The matches of `query` among `rows`, counting a row only when the feed draws it: a system
   * message of `systemMessageByRowId`, the unfurled window's, or a row `drawsBody` has a body for.
   */
  public countOf(
    rows: readonly TranscriptEventRow[],
    query: string,
    systemMessageByRowId: ReadonlyMap<string, SystemMessageReading>,
    drawsBody: TranscriptRowRenderer["drawsBody"],
  ): number {
    const needle = query.trim().toLowerCase();
    const isCounted = (row: TranscriptEventRow): boolean =>
      rowMatches(row, needle, systemMessageByRowId) &&
      isDrawnRow(row, systemMessageByRowId, drawsBody);
    // A row that left is matched as it was counted, against the system messages of its own pass.
    const previousSystemMessageByRowId = this.#systemMessageByRowId;
    const wasCounted = (row: TranscriptEventRow): boolean =>
      rowMatches(row, needle, previousSystemMessageByRowId) &&
      isDrawnRow(row, previousSystemMessageByRowId, drawsBody);
    const isSameQuestion = needle === this.#needle && drawsBody === this.#drawsBody;
    let count: number | undefined;
    if (needle.length === 0) {
      count = 0;
    } else if (isSameQuestion && rows === this.#rows) {
      count = this.#count;
    } else if (isSameQuestion) {
      count = this.#countMoved(rows, isCounted, wasCounted);
    }
    this.#rows = rows;
    this.#needle = needle;
    this.#systemMessageByRowId = systemMessageByRowId;
    this.#drawsBody = drawsBody;
    this.#count = count ?? rows.filter(isCounted).length;
    return this.#count;
  }

  // The held count moved by the rows that differ between the held list and `rows`. Every row of
  // either list is passed once, as one both hold or as one that left or joined, so the count holds
  // for lists in any order; in log order, only the rows that moved are matched.
  #countMoved(
    rows: readonly TranscriptEventRow[],
    isCounted: (row: TranscriptEventRow) => boolean,
    wasCounted: (row: TranscriptEventRow) => boolean,
  ): number {
    const previousRows = this.#rows;
    let count = this.#count;
    let previousPosition = 0;
    let position = 0;
    while (previousPosition < previousRows.length || position < rows.length) {
      const previousRow = previousRows[previousPosition];
      const row = rows[position];
      if (previousRow === row) {
        previousPosition += 1;
        position += 1;
        continue;
      }
      // A row projected again stands at its own sequence in both lists, so it leaves and joins.
      if (
        row === undefined ||
        (previousRow !== undefined && previousRow.sequence <= row.sequence)
      ) {
        previousPosition += 1;
        count -= wasCounted(previousRow as TranscriptEventRow) ? 1 : 0;
      }
      if (
        previousRow === undefined ||
        (row !== undefined && row.sequence <= previousRow.sequence)
      ) {
        position += 1;
        count += isCounted(row as TranscriptEventRow) ? 1 : 0;
      }
    }
    return count;
  }
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
export function findInTranscript(
  rows: readonly TranscriptEventRow[],
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

/** Whether the text a row draws holds `needle`, already lowercased. */
function rowMatches(
  row: TranscriptEventRow,
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
  row: TranscriptEventRow,
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
      return toolRowHeadingText(toolRowHeadingOf(row, undefined));
    case "agent-message":
    case "thinking":
    case undefined:
      return undefined;
  }
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
