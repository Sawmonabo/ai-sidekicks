// The index's ranking of a search's words, read once, when the search's first page is asked for.
// BM25 scores every matching row against the whole index, so a write anywhere moves every score
// a little; the ranking is kept as it was read, and every later page of the search walks that one
// ranking, which neither repeats nor drops a row however the index moves meanwhile. Rows are kept
// in rowid order, which the index gives without sorting and a rank lookup searches, and are taken
// best first from a heap, so a page orders only the rows it reaches rather than every match.
// A search by tag and words whose tag few sessions carry ranks only the rows those sessions and
// their groups own, read through their keys in one pass, so it costs what they hold rather than
// what the whole index holds. A tag many sessions carry reads every matching row with its session
// instead, which past that point costs less than the merge of their keys.

import type { Database, Statement } from "better-sqlite3";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";
import type { SessionGroupId } from "@ai-sidekicks/contracts/session/groups";

import { indexRowKindOf, narrowToOwners, ownerIdsOf } from "./index/columns.js";

// One stretch of rowids' matching rows. The index seeks to a rowid bound only when it is an
// integer, and a JavaScript number binds as a real, so each bound is cast.
const RANGE_FILTER_SQL = `
     AND session_search_index.rowid >= CAST(@low AS INTEGER)
     AND session_search_index.rowid < CAST(@high AS INTEGER)`;

const RANKED_ROWS_SQL = `
  SELECT rowid AS index_rowid, rank
    FROM session_search_index
   WHERE session_search_index MATCH @expression ${RANGE_FILTER_SQL}
   ORDER BY rowid`;

// The rows some sessions and their groups own, scored as the whole index ranks them: the key column
// only narrows, so it weighs nothing, and the words' weights come from the whole index either way.
const NARROWED_RANKED_ROWS_SQL = `
  SELECT rowid AS index_rowid, bm25(session_search_index, 1.0, 0.0) AS rank, session_id, sequence
    FROM session_search_index
   WHERE session_search_index MATCH @expression`;

// Each matching row's session and position come from the index's session table, which a row's
// lookup finds in its few cached pages, rather than from the index's content, whose rows hold the
// text and cost a read of their own page each.
const RANKED_ROWS_WITH_SESSIONS_SQL = `
  SELECT session_search_index.rowid AS index_rowid, rank, row_session.session_rowid,
         row_session.sequence
    FROM session_search_index
    LEFT JOIN session_search_index_sessions AS row_session
      ON row_session.index_rowid = session_search_index.rowid
   WHERE session_search_index MATCH @expression ${RANGE_FILTER_SQL}
   ORDER BY session_search_index.rowid`;

// A matching row as the ranking read gives it: its rowid and its rank.
type RankedRow = readonly [indexRowid: number, rank: number];

// A matching row with its session's rowid, `null` on a group's row, and its position in the log,
// `null` on any row not the log's.
type RankedSessionRow = readonly [
  indexRowid: number,
  rank: number,
  sessionRowid: number | null,
  sequence: number | null,
];

// What one matching row costs the ranking: its rowid and rank as doubles, its heap slot.
const BYTES_PER_ROW = 8 + 8 + 4;

// A read's arrays start this long and double as rows arrive.
const FIRST_RANKING_CAPACITY = 1024;

// The most sessions and groups one narrowed read names. Past it, the index's merge of their keys
// costs more than another pass over the words does.
const NARROWED_READ_OWNERS = 256;
/**
 * The most sessions and groups a ranking within sessions narrows to; past four narrowed reads, one
 * read of every match costs less.
 */
export const NARROWED_RANKING_OWNERS: number = 4 * NARROWED_READ_OWNERS;

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
  /** Takes the best row not yet taken; `undefined` once every row has been. */
  takeBestRow(): RankedRowKey | undefined;
  /** Roughly how many bytes the ranking holds. */
  readonly byteLength: number;
}

/** A matching index row a ranking within sessions read, with its session and position. */
export interface RankedIndexRow {
  readonly index_rowid: number;
  readonly rank: number;
  /** `null` on a group's row, which belongs to every session in the group. */
  readonly session_id: SessionId | null;
  /** The log row's position, `null` on a title, group or tag row. */
  readonly sequence: number | null;
}

/** A session a ranking within sessions reads, and the group whose row is the session's too. */
export interface RankedSessionScope {
  readonly sessionId: SessionId;
  /** The session's rowid in the directory, by which the index's session table names it. */
  readonly sessionRowid: number;
  readonly groupId: SessionGroupId | null;
  /** The index rowid of the group's row, `null` for a session in no group. */
  readonly groupIndexRowid: number | null;
}

/** A ranking within some sessions, and every matching row those sessions and their groups own. */
export interface SessionsRanking {
  readonly ranking: TextRanking;
  readonly rows: readonly RankedIndexRow[];
}

/** The rowids from `low` up to but not including `high`. */
export interface RowidRange {
  readonly low: number;
  readonly high: number;
}

/** Every rowid the index can hold. */
export const WHOLE_INDEX: RowidRange = { low: 0, high: Number.MAX_SAFE_INTEGER };

/**
 * One rowid range's matching rows, ranked, in rowid order; with each row's session and position
 * when the ranking reads every match with its session.
 */
export interface RankedRange {
  readonly rowids: Float64Array<ArrayBuffer>;
  readonly ranks: Float64Array<ArrayBuffer>;
  /** Each row's session's rowid in the directory, `NaN` on a row with none, such as a group's. */
  readonly sessionRowids?: Float64Array<ArrayBuffer>;
  /** Each row's position in its session's log, `NaN` on a title, group or tag row. */
  readonly sequences?: Float64Array<ArrayBuffer>;
}

/**
 * Whether a ranking within these sessions reads every match with its session rather than narrowing
 * to their keys: past four narrowed reads, one read of every match costs less.
 */
export function ranksEveryMatch(sessions: readonly RankedSessionScope[]): boolean {
  return ownerIdsOf(sessions).length > NARROWED_RANKING_OWNERS;
}

/** Reads the index's ranking of a search's words. */
export class SessionTextRanking {
  readonly #rankedRows: Statement<{ expression: string }, RankedRow>;
  readonly #narrowedRankedRows: Statement<{ expression: string }, RankedIndexRow>;
  readonly #rankedRowsWithSessions: Statement<{ expression: string }, RankedSessionRow>;
  readonly #rows = new RankingRows();

  constructor(reader: Database) {
    this.#rankedRows = reader.prepare<{ expression: string }, RankedRow>(RANKED_ROWS_SQL).raw(true);
    this.#narrowedRankedRows = reader.prepare(NARROWED_RANKED_ROWS_SQL);
    this.#rankedRowsWithSessions = reader
      .prepare<{ expression: string }, RankedSessionRow>(RANKED_ROWS_WITH_SESSIONS_SQL)
      .raw(true);
  }

  /** Every row the match expression finds, ranked, in one read. */
  rank(matchExpression: string): TextRanking {
    return rankingOfRanges([this.rankRange(matchExpression, WHOLE_INDEX)]);
  }

  /** The rows the match expression finds in one rowid range, ranked as the whole index would. */
  rankRange(matchExpression: string, range: RowidRange): RankedRange {
    // Streamed into the arrays, so the rows never sit in memory as one row object each.
    const rows = this.#rows;
    rows.clear();
    for (const [indexRowid, rank] of this.#rankedRows.iterate({
      expression: matchExpression,
      ...range,
    })) {
      rows.add(indexRowid, rank);
    }
    return rows.range();
  }

  /** As {@link rankRange}, reading each row's session and position too. */
  rankRangeWithSessions(matchExpression: string, range: RowidRange): RankedRange {
    const rows = this.#rows;
    rows.clear();
    for (const [indexRowid, rank, sessionRowid, sequence] of this.#rankedRowsWithSessions.iterate({
      expression: matchExpression,
      ...range,
    })) {
      rows.addWithSession(indexRowid, rank, sessionRowid ?? Number.NaN, sequence ?? Number.NaN);
    }
    return rows.rangeWithSessions();
  }

  /**
   * The rows the match expression finds that these sessions and their groups own, ranked as
   * {@link rank} ranks them, with those rows read.
   */
  rankWithinSessions(
    matchExpression: string,
    sessions: readonly RankedSessionScope[],
  ): SessionsRanking {
    if (ranksEveryMatch(sessions)) {
      return sessionsRankingOfRanges(
        [this.rankRangeWithSessions(matchExpression, WHOLE_INDEX)],
        sessions,
      );
    }
    const ownerIds = ownerIdsOf(sessions);
    const rows: RankedIndexRow[] = [];
    for (let start = 0; start < ownerIds.length; start += NARROWED_READ_OWNERS) {
      const expression = narrowToOwners(
        matchExpression,
        ownerIds.slice(start, start + NARROWED_READ_OWNERS),
      );
      for (const row of this.#narrowedRankedRows.iterate({ expression })) {
        rows.push(row);
      }
    }
    // Each read gives its rows in rowid order, but the reads interleave, so the whole is sorted.
    rows.sort((left, right) => left.index_rowid - right.index_rowid);
    return {
      ranking: rankingOf(
        Float64Array.from(rows, (row) => row.index_rowid),
        Float64Array.from(rows, (row) => row.rank),
      ),
      rows,
    };
  }
}

/** The ranking over these ranges' rows; the ranges come in rowid order and do not overlap. */
export function rankingOfRanges(ranges: readonly RankedRange[]): TextRanking {
  const [onlyRange] = ranges;
  if (ranges.length === 1 && onlyRange !== undefined) {
    return rankingOf(onlyRange.rowids, onlyRange.ranks);
  }
  const rowCount = ranges.reduce((count, range) => count + range.rowids.length, 0);
  const rowids = new Float64Array(rowCount);
  const ranks = new Float64Array(rowCount);
  let offset = 0;
  for (const range of ranges) {
    rowids.set(range.rowids, offset);
    ranks.set(range.ranks, offset);
    offset += range.rowids.length;
  }
  return rankingOf(rowids, ranks);
}

/**
 * The ranking within some sessions over these ranges, each read with its sessions by
 * {@link SessionTextRanking.rankRangeWithSessions}, and the rows those sessions and their groups
 * own among them; the ranges come in rowid order.
 */
export function sessionsRankingOfRanges(
  ranges: readonly RankedRange[],
  sessions: readonly RankedSessionScope[],
): SessionsRanking {
  const sessionIdsByRowid = new Map(
    sessions.map((session) => [session.sessionRowid, session.sessionId]),
  );
  const groupIndexRowids = new Set(sessions.map((session) => session.groupIndexRowid));
  const rows: RankedIndexRow[] = [];
  for (const { rowids, ranks, sessionRowids, sequences } of ranges) {
    for (let position = 0; position < rowids.length; position += 1) {
      const indexRowid = rowids[position] ?? 0;
      const rank = ranks[position] ?? 0;
      if (indexRowKindOf(indexRowid) === "group") {
        if (groupIndexRowids.has(indexRowid)) {
          rows.push({ index_rowid: indexRowid, rank, session_id: null, sequence: null });
        }
        continue;
      }
      const sessionId = sessionIdsByRowid.get(sessionRowids?.[position] ?? Number.NaN);
      if (sessionId !== undefined) {
        const sequence = sequences?.[position] ?? Number.NaN;
        rows.push({
          index_rowid: indexRowid,
          rank,
          session_id: sessionId,
          sequence: Number.isNaN(sequence) ? null : sequence,
        });
      }
    }
  }
  return { ranking: rankingOfRanges(ranges), rows };
}

// The ranking over rows already in rowid order.
function rankingOf(rowids: Float64Array, ranks: Float64Array): TextRanking {
  // Built at the first take, since a search by tag and words orders its sessions without it.
  let heap: RankHeap | undefined;
  return {
    rankOf: (indexRowid) => {
      const position = firstPositionAtOrAfter(rowids, indexRowid);
      return rowids[position] === indexRowid ? ranks[position] : undefined;
    },
    takeBestRow: () => {
      heap ??= new RankHeap(rowids, ranks);
      const position = heap.take();
      return position === undefined
        ? undefined
        : { rank: ranks[position] ?? 0, indexRowid: rowids[position] ?? 0 };
    },
    byteLength: rowids.length * BYTES_PER_ROW,
  };
}

// A ranking's rows as one read gives them, in arrays kept from read to read that double when full,
// so they grow to the largest read and no read leaves garbage behind but the copies it returns.
// The session columns grow only for reads that fill them.
class RankingRows {
  #rowids: Float64Array<ArrayBuffer> = new Float64Array(FIRST_RANKING_CAPACITY);
  #ranks: Float64Array<ArrayBuffer> = new Float64Array(FIRST_RANKING_CAPACITY);
  #sessionRowids: Float64Array<ArrayBuffer> = new Float64Array(FIRST_RANKING_CAPACITY);
  #sequences: Float64Array<ArrayBuffer> = new Float64Array(FIRST_RANKING_CAPACITY);
  #count = 0;

  clear(): void {
    this.#count = 0;
  }

  add(indexRowid: number, rank: number): void {
    if (this.#count === this.#rowids.length) {
      this.#rowids = grown(this.#rowids);
      this.#ranks = grown(this.#ranks);
    }
    this.#rowids[this.#count] = indexRowid;
    this.#ranks[this.#count] = rank;
    this.#count += 1;
  }

  addWithSession(indexRowid: number, rank: number, sessionRowid: number, sequence: number): void {
    if (this.#count === this.#sessionRowids.length) {
      this.#sessionRowids = grown(this.#sessionRowids);
      this.#sequences = grown(this.#sequences);
    }
    this.#sessionRowids[this.#count] = sessionRowid;
    this.#sequences[this.#count] = sequence;
    this.add(indexRowid, rank);
  }

  range(): RankedRange {
    return {
      rowids: this.#rowids.slice(0, this.#count),
      ranks: this.#ranks.slice(0, this.#count),
    };
  }

  rangeWithSessions(): RankedRange {
    return {
      ...this.range(),
      sessionRowids: this.#sessionRowids.slice(0, this.#count),
      sequences: this.#sequences.slice(0, this.#count),
    };
  }
}

function grown(values: Float64Array): Float64Array<ArrayBuffer> {
  const larger = new Float64Array(values.length * 2);
  larger.set(values);
  return larger;
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
