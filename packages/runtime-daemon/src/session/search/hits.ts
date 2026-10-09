// The line each hit shows, read from the database by the hit's key: the row's text as it is now,
// marked where the search matches it. The index stores no text, so a hit whose row is gone since
// the index saw it is passed over, and one whose text changed is marked on its current text, or
// passed over once that text no longer holds a match. A search with words marks them as the index
// finds them; a search by tags alone marks each tag's levels the queried tag names.

import type { SearchIndex, SearchQuery } from "@ai-sidekicks/search-index";
import type { SearchMatchRange } from "@ai-sidekicks/contracts/session/methods";

import type { IndexRowReader, SourceRow } from "./index/rows.js";
import { cutMarkedLine, type MarkedLine } from "./marked-line.js";

/** A hit's row as the database holds it now, and the marked line the hit shows. */
export interface HitLine {
  readonly row: SourceRow;
  readonly marked: MarkedLine;
}

// Hits' keys in the order they show: a list, or the typed array a session's find returns.
type HitKeys = readonly number[] | Float64Array;

// Where a search matches a row's current text, in order; none once the text holds no match.
type MatchMarker = (row: SourceRow) => readonly SearchMatchRange[];

/** Reads and marks hits' lines on one connection, each cut to the length its search shows. */
export class HitLineReader {
  readonly #rows: IndexRowReader;
  readonly #index: Pick<SearchIndex, "markMatches">;
  readonly #lineMaxLength: number;

  /** `lineMaxLength` is the most UTF-16 code units a line shows. */
  constructor(
    rows: IndexRowReader,
    index: Pick<SearchIndex, "markMatches">,
    lineMaxLength: number,
  ) {
    this.#rows = rows;
    this.#index = index;
    this.#lineMaxLength = lineMaxLength;
  }

  /**
   * The lines of the first `count` of these keys' rows that still hold a match of the query's
   * words, marked as the index marks them, in the keys' order. Rows are read only as far as that
   * takes.
   */
  readLines(keys: HitKeys, query: SearchQuery, count: number): HitLine[] {
    return this.#readMarkedLines(keys, (row) => this.#index.markMatches(row.text, query), count);
  }

  /**
   * The lines of the first `count` of these keys' tag rows that a queried tag, each a tag fold,
   * still matches, in the keys' order: each tag marked through as many levels as the longest
   * queried tag it is or is nested under has.
   */
  readTagLines(keys: HitKeys, tagFolds: readonly string[], count: number): HitLine[] {
    return this.#readMarkedLines(keys, (row) => tagMatchRanges(row, tagFolds), count);
  }

  #readMarkedLines(keys: HitKeys, marker: MatchMarker, count: number): HitLine[] {
    const lines: HitLine[] = [];
    let next = 0;
    while (lines.length < count && next < keys.length) {
      const chunk = keys.slice(next, next + count - lines.length);
      next += chunk.length;
      const rows = this.#rows.readRows(chunk);
      for (const key of chunk) {
        const row = rows.get(key);
        if (row === undefined) {
          continue;
        }
        const [firstRange, ...laterRanges] = marker(row);
        if (firstRange !== undefined) {
          lines.push({
            row,
            marked: cutMarkedLine(row.text, [firstRange, ...laterRanges], this.#lineMaxLength),
          });
        }
      }
    }
    return lines;
  }
}

function tagMatchRanges(row: SourceRow, tagFolds: readonly string[]): SearchMatchRange[] {
  if (row.tag === undefined) {
    return [];
  }
  const { fold } = row.tag;
  let levelCount = 0;
  for (const tagFold of tagFolds) {
    if (fold === tagFold || fold.startsWith(`${tagFold}/`)) {
      levelCount = Math.max(levelCount, tagFold.split("/").length);
    }
  }
  return levelCount === 0 ? [] : [leadingLevelsRange(row.text, levelCount)];
}

// The stretch of a tag holding its first `levelCount` levels.
function leadingLevelsRange(tag: string, levelCount: number): SearchMatchRange {
  let end = -1;
  for (let level = 0; level < levelCount; level += 1) {
    end = tag.indexOf("/", end + 1);
    if (end === -1) {
      return { start: 0, end: tag.length };
    }
  }
  return { start: 0, end };
}
