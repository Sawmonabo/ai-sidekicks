// The index's ranking of a search's words, read once, when the search's first page is asked for.
// BM25 scores every matching row against the whole index, so a write anywhere moves every score
// a little; the ranking is kept as it was read, and every later page of the search walks that one
// ranking, which neither repeats nor drops a row however the index moves meanwhile. Rows are kept
// in rowid order, which the index gives without sorting and a rank lookup searches, and are taken
// best first from a heap, so a page orders only the rows it reaches rather than every match.

import type { Database, Statement } from "better-sqlite3";

import { indexRowKindOf, isEventRowSql } from "./index-columns.js";
import { MATCH_CLOSE_MARK, MATCH_OPEN_MARK } from "./marked-line.js";

// A title, group or tag row is marked here, since those rows carry no session key a later read
// could narrow to; a log row is marked later, only for the sessions a page reads.
const RANKED_ROWS_SQL = `
  SELECT rowid AS index_rowid, rank,
         CASE WHEN NOT ${isEventRowSql("rowid")}
              THEN highlight(session_search_index, 0, @open, @close) END AS marked
    FROM session_search_index
   WHERE session_search_index MATCH @expression
   ORDER BY rowid`;

// A matching row as the read gives it: rowid, rank, and the marked text of a row not the log's.
type RankedRow = readonly [indexRowid: number, rank: number, marked: string | null];

// What one matching row costs the ranking: its rowid and rank as doubles, its heap slot.
const BYTES_PER_ROW = 8 + 8 + 4;

/** A matching index row's place in the ranking: its BM25 rank, then its rowid. */
export interface RankedRowKey {
  readonly rank: number;
  readonly indexRowid: number;
}

/** Orders matching rows best first: by BM25 rank, then by rowid, so every page agrees on ties. */
export function compareRankedRows(left: RankedRowKey, right: RankedRowKey): number {
  return left.rank - right.rank || left.indexRowid - right.indexRowid;
}

/** One search's matching rows, each with the rank it had when the search was first read. */
export interface TextRanking {
  /** The row's rank, `undefined` for a row the words did not match when the ranking was read. */
  rankOf(indexRowid: number): number | undefined;
  /** A matching title, group or tag row's marked text, `undefined` for any other row. */
  markedTextOf(indexRowid: number): string | undefined;
  /** The rowids of every matching log row, in rowid order. */
  eventRowids(): number[];
  /** Takes the best row not yet taken; `undefined` once every row has been. */
  takeBestRow(): RankedRowKey | undefined;
  /** Roughly how many bytes the ranking holds. */
  readonly byteLength: number;
}

/** Reads the index's ranking of a search's words. */
export class SessionTextRanking {
  readonly #rankedRows: Statement<{ expression: string; open: string; close: string }, RankedRow>;

  constructor(reader: Database) {
    this.#rankedRows = reader
      .prepare<{ expression: string; open: string; close: string }, RankedRow>(RANKED_ROWS_SQL)
      .raw(true);
  }

  /** Every row the match expression finds, ranked, in one read. */
  rank(matchExpression: string): TextRanking {
    const rows = this.#rankedRows.all({
      expression: matchExpression,
      open: MATCH_OPEN_MARK,
      close: MATCH_CLOSE_MARK,
    });
    const rowids = new Float64Array(rows.length);
    const ranks = new Float64Array(rows.length);
    const markedTexts = new Map<number, string>();
    let markedBytes = 0;
    rows.forEach(([indexRowid, rank, marked], position) => {
      rowids[position] = indexRowid;
      ranks[position] = rank;
      if (marked !== null) {
        markedTexts.set(indexRowid, marked);
        markedBytes += marked.length * 2;
      }
    });
    // Built at the first take, since a search by tag and words orders its sessions without it.
    let heap: RankHeap | undefined;
    const positionOf = (indexRowid: number): number | undefined => {
      const position = firstPositionAtOrAfter(rowids, indexRowid);
      return rowids[position] === indexRowid ? position : undefined;
    };
    return {
      rankOf: (indexRowid) => {
        const position = positionOf(indexRowid);
        return position === undefined ? undefined : ranks[position];
      },
      markedTextOf: (indexRowid) => markedTexts.get(indexRowid),
      eventRowids: () =>
        Array.from(rowids).filter((indexRowid) => indexRowKindOf(indexRowid) === "event"),
      takeBestRow: () => {
        heap ??= new RankHeap(rowids, ranks);
        const position = heap.take();
        return position === undefined
          ? undefined
          : { rank: ranks[position] ?? 0, indexRowid: rowids[position] ?? 0 };
      },
      byteLength: rows.length * BYTES_PER_ROW + markedBytes,
    };
  }
}

// A binary min-heap of row positions, best row on top. Building it is linear in the rows, and each
// take is logarithmic, so the rows no page reaches are never put in order.
class RankHeap {
  readonly #rowids: Float64Array;
  readonly #ranks: Float64Array;
  readonly #positions: Uint32Array;
  #size: number;

  constructor(rowids: Float64Array, ranks: Float64Array) {
    this.#rowids = rowids;
    this.#ranks = ranks;
    this.#size = rowids.length;
    this.#positions = new Uint32Array(this.#size);
    for (let slot = 0; slot < this.#size; slot += 1) {
      this.#positions[slot] = slot;
    }
    for (let slot = (this.#size >> 1) - 1; slot >= 0; slot -= 1) {
      this.#siftDown(slot);
    }
  }

  take(): number | undefined {
    if (this.#size === 0) {
      return undefined;
    }
    const best = this.#positions[0];
    this.#size -= 1;
    this.#positions[0] = this.#positions[this.#size] ?? 0;
    this.#siftDown(0);
    return best;
  }

  #siftDown(fromSlot: number): void {
    const positions = this.#positions;
    let slot = fromSlot;
    for (;;) {
      const left = 2 * slot + 1;
      let best = slot;
      if (left < this.#size && this.#isBetter(left, best)) {
        best = left;
      }
      if (left + 1 < this.#size && this.#isBetter(left + 1, best)) {
        best = left + 1;
      }
      if (best === slot) {
        return;
      }
      const moved = positions[slot] ?? 0;
      positions[slot] = positions[best] ?? 0;
      positions[best] = moved;
      slot = best;
    }
  }

  #isBetter(slot: number, otherSlot: number): boolean {
    const position = this.#positions[slot] ?? 0;
    const otherPosition = this.#positions[otherSlot] ?? 0;
    const byRank = (this.#ranks[position] ?? 0) - (this.#ranks[otherPosition] ?? 0);
    return (
      byRank < 0 ||
      (byRank === 0 && (this.#rowids[position] ?? 0) < (this.#rowids[otherPosition] ?? 0))
    );
  }
}

// The first position whose rowid is not below `indexRowid`, in rowids sorted ascending.
function firstPositionAtOrAfter(rowids: Float64Array, indexRowid: number): number {
  let low = 0;
  let high = rowids.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((rowids[middle] ?? 0) < indexRowid) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}
