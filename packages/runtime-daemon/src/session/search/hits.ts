// The line each hit shows, read from the database by the hit's key: the row's text as it is now,
// marked where the index finds the query's words in it. The index stores no text, so a hit whose
// row is gone since the index saw it is passed over, and one whose text changed is marked on its
// current text, or passed over once that text no longer holds a match.

import type { SearchIndex, SearchQuery } from "@ai-sidekicks/search-index";
import { TRANSCRIPT_SEARCH_TEXT_MAX_LEN } from "@ai-sidekicks/contracts/transcript/search";

import type { IndexRowReader, SourceRow } from "./index/rows.js";
import { cutMarkedLine, type MarkedLine } from "./marked-line.js";

/** A hit's row as the database holds it now, and the marked line the hit shows. */
export interface HitLine {
  readonly row: SourceRow;
  readonly marked: MarkedLine;
}

/** Reads and marks hits' lines on one connection, as the index marks matches. */
export class HitLineReader {
  readonly #rows: IndexRowReader;
  readonly #index: Pick<SearchIndex, "markMatches">;

  constructor(rows: IndexRowReader, index: Pick<SearchIndex, "markMatches">) {
    this.#rows = rows;
    this.#index = index;
  }

  /**
   * The lines of the first `count` of these keys' rows that still hold a match, in the keys'
   * order. Rows are read only as far as that takes.
   */
  readLines(keys: readonly number[], query: SearchQuery, count: number): HitLine[] {
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
        const [firstRange, ...laterRanges] = this.#index.markMatches(row.text, query);
        if (firstRange !== undefined) {
          lines.push({
            row,
            marked: cutMarkedLine(
              row.text,
              [firstRange, ...laterRanges],
              TRANSCRIPT_SEARCH_TEXT_MAX_LEN,
            ),
          });
        }
      }
    }
    return lines;
  }
}
