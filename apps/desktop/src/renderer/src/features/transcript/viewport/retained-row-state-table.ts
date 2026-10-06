// The retained row state table: what a row body retained, and what survives the row itself.
// `window-cap.ts` decides which rows the window keeps and parks a key it is about to drop;
// everything else about parking lives here. States are parked under a synthetic key rather than
// deleted, and the parked table is bounded, evicting the least recently parked.

import { type TranscriptRowDensity } from "../rows/renderer.js";

/**
 * Pruned rows whose retained state the window parks under a synthetic key.
 *
 * Bounded like every cache here: a person who pages back expects the row they had open to
 * still be open, not one pruned an hour ago. One window's worth covers a page back.
 */
const TRANSCRIPT_PARKED_STATE_CAP = 400;

/**
 * Renderer-local state a row body keeps in the list.
 *
 * `density` is the row renderer's own type (`features/transcript/rows/renderer.ts`), so the table
 * parks exactly what the list decides.
 */
export interface RetainedRowState {
  readonly density: TranscriptRowDensity;
  /** Offset inside the row's own clamped body, so a re-shown row reopens where it was. */
  readonly innerScrollTopPx: number;
}

/** The live and parked state tables, and the one rule that moves a row between them. */
export class RetainedRowStateTable {
  readonly #parkedStateCap: number;
  readonly #liveStateByRowKey = new Map<string, RetainedRowState>();
  /** Insertion-ordered, so the cap evicts the least recently parked. */
  readonly #parkedStateBySyntheticKey = new Map<string, RetainedRowState>();

  public constructor(parkedStateCap: number = TRANSCRIPT_PARKED_STATE_CAP) {
    this.#parkedStateCap = parkedStateCap;
  }

  /** A row body's retained state; the live table answers before the parked one. */
  public retainedState(rowKey: string): RetainedRowState | undefined {
    return (
      this.#liveStateByRowKey.get(rowKey) ??
      this.#parkedStateBySyntheticKey.get(this.#syntheticKeyFor(rowKey))
    );
  }

  /** Record what a row body retains while the window holds its row. */
  public setRetainedState(rowKey: string, state: RetainedRowState): void {
    this.#liveStateByRowKey.set(rowKey, state);
  }

  /**
   * Move a retained state from the live table to the parked one, under a synthetic key.
   *
   * A no-op for a row that retained nothing, so the cap may call this for every key it
   * drops without first asking whether there is anything to park.
   */
  public park(rowKey: string): void {
    const state = this.#liveStateByRowKey.get(rowKey);
    if (state === undefined) {
      return;
    }
    this.#liveStateByRowKey.delete(rowKey);
    const syntheticKey = this.#syntheticKeyFor(rowKey);
    this.#parkedStateBySyntheticKey.delete(syntheticKey);
    this.#parkedStateBySyntheticKey.set(syntheticKey, state);
    while (this.#parkedStateBySyntheticKey.size > this.#parkedStateCap) {
      const oldestKey = this.#parkedStateBySyntheticKey.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.#parkedStateBySyntheticKey.delete(oldestKey);
    }
  }

  /**
   * Park every live state whose row is not in `presentRowKeys`, so the live table holds no more
   * than the rows the window holds, whichever way a row left it.
   */
  public parkAllExcept(presentRowKeys: ReadonlySet<string>): void {
    for (const rowKey of [...this.#liveStateByRowKey.keys()]) {
      if (!presentRowKeys.has(rowKey)) {
        this.park(rowKey);
      }
    }
  }

  /**
   * Drops every parked state. The idle trim (`idle-trim.ts`) calls it after a quiet period;
   * live states belong to rows the window holds and are untouched.
   */
  public releaseParkedStates(): void {
    this.#parkedStateBySyntheticKey.clear();
  }

  /** The parked key, prefixed so a lookup can never mistake a parked state for a live one. */
  #syntheticKeyFor(rowKey: string): string {
    return `parked:${rowKey}`;
  }
}
