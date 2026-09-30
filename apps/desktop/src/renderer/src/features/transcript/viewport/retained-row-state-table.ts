// The row-lease table: what a row body leased, and what survives the row itself.
// `window-cap.ts` decides which rows the window keeps and parks a key it is about to drop;
// everything else about parking lives here. Leases are parked under a synthetic key rather than
// deleted, and the parked table is bounded, evicting the least recently parked.

import { TRANSCRIPT_PARKED_LEASE_CAP } from "../frame/frame-caps.js";
import { type TranscriptRowDensity } from "../transcript-row-renderer.js";

/**
 * Renderer-local state a row body leases from the list.
 *
 * `density` is the row renderer's own type (`transcript-row-renderer.ts`), so the table parks
 * exactly what the list decides.
 */
export interface RetainedRowState {
  readonly density: TranscriptRowDensity;
  /** Offset inside the row's own clamped body, so a re-shown row reopens where it was. */
  readonly innerScrollTopPx: number;
}

/** The live and parked lease tables, and the one rule that moves a row between them. */
export class RetainedRowStateTable {
  readonly #parkedLeaseCap: number;
  readonly #leaseByRowKey = new Map<string, RetainedRowState>();
  /** Insertion-ordered, so the cap evicts the least recently parked. */
  readonly #parkedLeaseBySyntheticKey = new Map<string, RetainedRowState>();

  public constructor(parkedLeaseCap: number = TRANSCRIPT_PARKED_LEASE_CAP) {
    this.#parkedLeaseCap = parkedLeaseCap;
  }

  /** A row body's leased state; the live table answers before the parked one. */
  public lease(rowKey: string): RetainedRowState | undefined {
    return (
      this.#leaseByRowKey.get(rowKey) ??
      this.#parkedLeaseBySyntheticKey.get(this.#syntheticKeyFor(rowKey))
    );
  }

  public setLease(rowKey: string, lease: RetainedRowState): void {
    this.#leaseByRowKey.set(rowKey, lease);
  }

  /** How many leases are parked. The bound this table is held to is on this number. */
  public get parkedCount(): number {
    return this.#parkedLeaseBySyntheticKey.size;
  }

  /**
   * Move a lease from the live table to the parked one, under a synthetic key.
   *
   * A no-op for a row that leased nothing, so the cap may call this for every key it
   * drops without first asking whether there is anything to park.
   */
  public park(rowKey: string): void {
    const lease = this.#leaseByRowKey.get(rowKey);
    if (lease === undefined) {
      return;
    }
    this.#leaseByRowKey.delete(rowKey);
    const syntheticKey = this.#syntheticKeyFor(rowKey);
    this.#parkedLeaseBySyntheticKey.delete(syntheticKey);
    this.#parkedLeaseBySyntheticKey.set(syntheticKey, lease);
    while (this.#parkedLeaseBySyntheticKey.size > this.#parkedLeaseCap) {
      const oldestKey = this.#parkedLeaseBySyntheticKey.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.#parkedLeaseBySyntheticKey.delete(oldestKey);
    }
  }

  /**
   * Drops every parked lease and returns how many went. The idle trim (`idle-trim.ts`) calls it
   * after a quiet period; live leases belong to rows the window holds and are untouched.
   */
  public releaseParkedLeases(): number {
    const releasedCount = this.#parkedLeaseBySyntheticKey.size;
    this.#parkedLeaseBySyntheticKey.clear();
    return releasedCount;
  }

  /** The parked key, prefixed so a lookup can never mistake a parked lease for a live one. */
  #syntheticKeyFor(rowKey: string): string {
    return `parked:${rowKey}`;
  }
}
