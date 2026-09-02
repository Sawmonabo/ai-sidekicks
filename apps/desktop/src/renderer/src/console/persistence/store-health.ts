// What the store knows about itself, and the one place a refusal is classified.
//
// The chokepoint next door decides whether a write may land. This module decides
// what that decision MEANT: which refusals are the caller handing the store
// something it may not keep, which are the store failing to keep something
// legitimate, which of them fires the `persistence-value-class` tripwire, and what
// an operator reading the diagnostics surface is shown afterwards.
//
// WHY IT IS ITS OWN MODULE. Two failure modes that share no evidence. The
// chokepoint is wrong when a write it should have refused lands, or one it should
// have taken does not; this ledger is wrong when a refusal is filed under the wrong
// half of the caller/store line — a full disk reported as a caller defect, or a
// caller smuggling prose reported as storage pressure — and an operator then audits
// the wrong thing entirely. Neither reading tells you anything about the other, and
// the classification table is the part that has to be read as a table.
//
// Stateful, so it is a class with private fields rather than counters scattered
// across the store. Its readings are cumulative for the window's lifetime: nothing
// here resets, because a count that could be cleared cannot answer "has this
// happened since the window opened".

import { reportTripwire } from "../core/index.js";
import {
  unmeasuredQuota,
  type PersistenceAdapter,
  type PersistenceAdapterKind,
  type QuotaGauge,
} from "./adapter.js";
import type { PersistenceRefusal, PersistenceRefusalCode } from "./refusals.js";

/**
 * Which refusals mean the CALLER handed the store something it may not keep, as
 * opposed to the store failing to keep something legitimate.
 *
 * A total table over the closed code union rather than a disjunction inside an
 * `if`: the caller-fault half fires the `persistence-value-class` tripwire and the
 * other half deliberately does not — a full disk is nobody's defect. Written this
 * way so a new refusal code does not compile until somebody decides which side of
 * that line it falls on, which an `if` would have let it slip past silently.
 */
const IS_CALLER_FAULT_REFUSAL: Readonly<Record<PersistenceRefusalCode, boolean>> = {
  "address-not-identifier-shaped": true,
  "value-class-unknown": true,
  "value-shape-invalid": true,
  "value-not-identifier-shaped": true,
  "value-too-large": true,
  "adapter-unavailable": false,
  "quota-exceeded": false,
};

/**
 * The site a refused ADDRESS is reported under.
 *
 * Every other arm reports `partition/key`, which names the record the breach was
 * about. That is the one thing an address refusal cannot do: the address IS what
 * was wrong, and a tripwire report quoting it would carry the prose the store
 * just refused into the report — one layer further out than the chokepoint that
 * stopped it. The refusal's own detail names the offending component and its
 * length, which is what an author needs to find the call site.
 */
export const REFUSED_ADDRESS_SITE = "<address>";

/** What the diagnostics surface renders about storage. */
export interface PersistenceHealth {
  readonly adapterKind: PersistenceAdapterKind;
  readonly durable: boolean;
  readonly description: string;
  readonly quota: QuotaGauge;
  /** Writes refused since the window opened, by refusal code. */
  readonly refusalCounts: Readonly<Record<string, number>>;
  /** Reads that failed and returned "not loaded" rather than a value. */
  readonly failedReadCount: number;
  /** LRU trims performed under quota pressure. */
  readonly trimCount: number;
}

/** The store's running account of its own refusals, failures, and trims. */
export class PersistenceHealthLedger {
  readonly #refusalCounts = new Map<string, number>();
  #failedReadCount = 0;
  #trimCount = 0;
  // Not "0 of 0 bytes": nothing has been read yet, and the reason says so.
  #lastQuota: QuotaGauge = unmeasuredQuota("not-attempted");

  /**
   * File one refusal, and fire the tripwire if it is the caller's.
   *
   * Counting and classifying are one act on purpose. A count kept here while the
   * caller/store split was decided at the call site would let two arms of the
   * same write disagree about which side a code falls on, and the count would
   * still look right.
   */
  public recordRefusal(refusal: PersistenceRefusal, site: string): void {
    this.#refusalCounts.set(refusal.code, (this.#refusalCounts.get(refusal.code) ?? 0) + 1);
    if (IS_CALLER_FAULT_REFUSAL[refusal.code]) {
      // A caller tried to put something the durable store may not hold. In dev this
      // throws; in production it is reported and the write is refused.
      reportTripwire("persistence-value-class", site, refusal.detail);
    }
  }

  /** A read that failed and answered "not loaded" rather than throwing. */
  public recordFailedRead(): void {
    this.#failedReadCount += 1;
  }

  /** Partitions an LRU trim actually freed. Zero is a legitimate reading. */
  public recordTrim(freedPartitionCount: number): void {
    this.#trimCount += freedPartitionCount;
  }

  /** The newest quota gauge, kept so a synchronous render need not touch storage. */
  public recordQuota(quota: QuotaGauge): void {
    this.#lastQuota = quota;
  }

  /** The last gauge read, without touching storage. For a synchronous render. */
  public get lastQuota(): QuotaGauge {
    return this.#lastQuota;
  }

  /**
   * The reading the diagnostics surface renders, for one adapter.
   *
   * The adapter is passed in rather than held: this ledger outlives no adapter and
   * owns none, and a second reference to the one the store already awaited would
   * be a second answer to "which adapter is this store on".
   */
  public snapshot(adapter: PersistenceAdapter): PersistenceHealth {
    return {
      adapterKind: adapter.kind,
      durable: adapter.durable,
      description: adapter.describe(),
      quota: this.#lastQuota,
      refusalCounts: Object.fromEntries(this.#refusalCounts),
      failedReadCount: this.#failedReadCount,
      trimCount: this.#trimCount,
    };
  }
}
