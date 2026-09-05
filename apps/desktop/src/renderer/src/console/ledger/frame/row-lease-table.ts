// The row-lease table — what a row body leased, and what survives the row itself.
//
// Its own module because it is a different subject from the cap next door.
// `window-cap.ts` decides WHICH rows the window keeps; this decides what happens to
// the renderer-local state a body had leased when one of them goes. The two meet at
// exactly one call — the cap parks a key it is about to drop — and everything else
// about parking, the synthetic key, and the eviction bound lives here.
//
// TWO PROPERTIES, and both are failures this module exists to make unrepresentable:
//
//   • **Leases are parked, not dropped.** A row a person had expanded comes back
//     expanded when they page to it again, because its state was re-parked under a
//     synthetic key rather than deleted with the row.
//   • **The parked table is bounded, evicting the least recently parked.** A person
//     paging back expects the row they had open a moment ago to still be open, and
//     nobody expects that of a row pruned an hour ago. Unbounded, this table would
//     be the memory leak the cap above it exists to prevent.

import { type TimelineRowDensity } from "../../seats/index.js";
import { LEDGER_PARKED_LEASE_CAP } from "./frame-bounds.js";

/**
 * Renderer-local state a row body leases from the list.
 *
 * `density` is the seat's own vocabulary rather than a second collapse enumeration
 * (`seats/timeline-row-slot.ts`): the list decides a row's collapse state
 * and hands it down, so the table parking that decision has to park the same type.
 */
export interface LedgerRowLease {
  readonly density: TimelineRowDensity;
  /** Offset inside the row's own clamped body, so a re-shown row reopens where it was. */
  readonly innerScrollTopPx: number;
}

/** The live and parked lease tables, and the one rule that moves a row between them. */
export class LedgerRowLeaseTable {
  readonly #parkedLeaseCap: number;
  readonly #leaseByRowKey = new Map<string, LedgerRowLease>();
  /** Insertion-ordered, so the cap evicts the least recently parked. */
  readonly #parkedLeaseBySyntheticKey = new Map<string, LedgerRowLease>();

  public constructor(parkedLeaseCap: number = LEDGER_PARKED_LEASE_CAP) {
    this.#parkedLeaseCap = parkedLeaseCap;
  }

  /**
   * A row body's leased state, live or parked.
   *
   * The live table answers first: a row that was pruned and has since been re-read
   * has both, and the live one is the reader's current truth.
   */
  public lease(rowKey: string): LedgerRowLease | undefined {
    return (
      this.#leaseByRowKey.get(rowKey) ??
      this.#parkedLeaseBySyntheticKey.get(this.#syntheticKeyFor(rowKey))
    );
  }

  public setLease(rowKey: string, lease: LedgerRowLease): void {
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
   * The parked key.
   *
   * Prefixed rather than reusing the row key, so a parked lease can never be
   * mistaken for a live one by a lookup that forgot which table it was reading.
   */
  #syntheticKeyFor(rowKey: string): string {
    return `parked:${rowKey}`;
  }
}
