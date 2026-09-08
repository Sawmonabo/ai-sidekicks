// Where each loaded row sits on the replay clock, and what one offset reveals.
//
// SPLIT FROM THE ENGINE BESIDE IT BECAUSE THE TWO HOLD DIFFERENT KINDS OF THING. The
// engine holds what a replay is DOING — its state, its speed, the one frame it may
// have armed, the seam its last jump landed on — and every one of those moves while a
// walk runs. This holds where the rows ARE, which is decided once from the window the
// walk is over and never moves again: the order playback reveals in, each row's offset
// from the head, the span those offsets cover, and the two readings an elapsed offset
// answers.
//
// AND THE ORDER IS `occurredAt`, NOT THE LOG'S. Playback reveals rows in the order
// they happened, while the ledger renders them in the order the daemon admitted them,
// and the two differ wherever a row arrived out of wall-clock order. Every surface
// above reads the log's order; this is the one place the other one exists.

import { compareInstants, parseInstant } from "../../../core/index.js";

/** One row the replay can reveal, reduced to what playback orders by. */
export interface ReplayRow {
  readonly rowId: string;
  /** Wire-verbatim ISO instant. Playback orders by this and by nothing else. */
  readonly occurredAt: string;
}

/**
 * The ordering one walk plays over, built once from its rows.
 *
 * Every reading here is a pure function of an elapsed offset, so the engine holds no
 * copy of any of it and a surface renders a position rather than a derivation of its
 * own.
 */
export class ReplayRowClock {
  readonly #rowsInOrder: readonly ReplayRow[];
  readonly #offsetsMs: readonly number[];
  /**
   * Where each row sits in the ordered window, keyed by its id.
   *
   * Built once, because every caller that names a row — a seam jump, "replay from
   * here", the timestamp the control renders — otherwise scans the window, and the
   * seam jump scanned it once per seam on every press. A repeated row id is a
   * projection defect; the first occurrence wins, which is the row the ordering
   * put first.
   */
  readonly #rowIndexByRowId: ReadonlyMap<string, number>;
  readonly #spanMs: number;

  public constructor(rows: readonly ReplayRow[]) {
    // Ordered by `occurredAt`, which is what playback reveals in — a
    // sequence order would be the log's order, and the two differ wherever the
    // daemon admitted rows out of wall-clock order.
    // Parsed ONCE per row rather than three times: the sort comparator, the base,
    // and the offset all read the same instant, and `parseInstant` answers a
    // reading rather than a number that may be `NaN`.
    const readRows = rows.map((row) => ({ row, instant: parseInstant(row.occurredAt) }));
    const rowsInOrder = [...readRows].sort((left, right) =>
      compareInstants(left.instant, right.instant),
    );
    const firstMs = rowsInOrder[0]?.instant.epochMilliseconds ?? 0;
    const offsets = rowsInOrder.map(({ instant }) =>
      // An unreadable instant lands at the head rather than at `NaN`: the row is
      // still part of the session and dropping it would make replay show fewer
      // rows than the ledger does. `compareInstants` has already put such rows
      // last in the order, so the head they land at is the playback's own start.
      instant.epochMilliseconds === undefined ? 0 : instant.epochMilliseconds - firstMs,
    );
    const rowIndexByRowId = new Map<string, number>();
    for (const [index, { row }] of rowsInOrder.entries()) {
      if (!rowIndexByRowId.has(row.rowId)) {
        rowIndexByRowId.set(row.rowId, index);
      }
    }
    this.#rowsInOrder = rowsInOrder.map(({ row }) => row);
    this.#offsetsMs = offsets;
    this.#rowIndexByRowId = rowIndexByRowId;
    this.#spanMs = offsets.length === 0 ? 0 : Math.max(...offsets);
  }

  /** The window's whole span, in milliseconds. Zero for an empty or single-row window. */
  public get spanMs(): number {
    return this.#spanMs;
  }

  /** Where a row sits on the replay clock, or `undefined` for a row not in the window. */
  public offsetMsOf(rowId: string): number | undefined {
    const index = this.#rowIndexByRowId.get(rowId);
    return index === undefined ? undefined : (this.#offsetsMs[index] ?? 0);
  }

  /** The rows an elapsed offset has reached, in `occurredAt` order. */
  public revealedRowIdsAt(elapsedMs: number): readonly string[] {
    const revealed: string[] = [];
    for (const [index, row] of this.#rowsInOrder.entries()) {
      if ((this.#offsetsMs[index] ?? 0) <= elapsedMs) {
        revealed.push(row.rowId);
      }
    }
    return revealed;
  }

  /**
   * The instant an elapsed offset names — the last row it has reached.
   *
   * The window's HEAD where it has reached nothing, which is an empty window and
   * nothing else: offsets begin at zero and an offset is never negative, so a window
   * with rows always reveals its first.
   */
  public positionIsoAt(elapsedMs: number): string | undefined {
    const revealed = this.revealedRowIdsAt(elapsedMs);
    const lastRevealedId = revealed[revealed.length - 1];
    if (lastRevealedId === undefined) {
      return this.#rowsInOrder[0]?.occurredAt;
    }
    const index = this.#rowIndexByRowId.get(lastRevealedId);
    return index === undefined ? undefined : this.#rowsInOrder[index]?.occurredAt;
  }
}
