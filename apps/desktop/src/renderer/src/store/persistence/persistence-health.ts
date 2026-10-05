// What the store knows about itself, and the one place a refusal is classified.
//
// The chokepoint in `ui-state-store.ts` decides whether a write may land; this module decides
// what that decision meant: whether a refusal is the caller handing the store something it may
// not keep or the store failing to keep something legitimate, which fires the
// `persistence-value-class` tripwire, and what the store reports about itself. It is separate
// because the two can be wrong independently: a full disk reported as a caller defect sends a
// person to audit the wrong half. Counts are cumulative for the window's lifetime, since a
// count that could be cleared cannot answer "has this happened since the window opened".

import { reportTripwire } from "#renderer/lib/tripwires/tripwires.js";
import {
  unmeasuredQuota,
  type PersistenceAdapter,
  type PersistenceAdapterKind,
  type QuotaGauge,
} from "./persistence-adapter.js";
import type { PersistenceRefusal, PersistenceRefusalCode } from "./refusals.js";

/**
 * Which refusals mean the caller handed the store something it may not keep, as opposed to the
 * store failing to keep something legitimate.
 *
 * A total table over the closed code union, so a new code does not compile until it is
 * classified. Only the caller-fault half fires the tripwire; a full disk is nobody's defect.
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
 * The site a refused address is reported under. Other arms report `partition/key`, but a
 * tripwire report quoting a refused address would carry the prose the store just refused; the
 * refusal's own detail names the offending component and its length instead.
 */
export const REFUSED_ADDRESS_SITE = "<address>";

/** What the store reports about itself: its adapter, the quota gauge, refusals and trims. */
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
export class PersistenceHealthTracker {
  readonly #refusalCounts = new Map<string, number>();
  #failedReadCount = 0;
  #trimCount = 0;
  // Not "0 of 0 bytes": nothing has been read yet, and the reason says so.
  #lastQuota: QuotaGauge = unmeasuredQuota("not-attempted");

  /**
   * Files one refusal, and fires the tripwire if it is the caller's. Counting and classifying
   * are one act so two arms of a write cannot disagree about which side a code falls on.
   */
  public recordRefusal(refusal: PersistenceRefusal, site: string): void {
    this.#refusalCounts.set(refusal.code, (this.#refusalCounts.get(refusal.code) ?? 0) + 1);
    if (IS_CALLER_FAULT_REFUSAL[refusal.code]) {
      // In dev this throws; in production it is reported and the write is refused.
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
   * The store's report on itself, for one adapter. The adapter is passed in rather
   * than held, so there is one answer to which adapter the store is on.
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
