// The persistence adapter seam. The renderer has IndexedDB only because the custom scheme is
// registered `standard: true` before `app.ready`; without it the console falls back to in-memory
// state and says so. `describe()` returns the sentence that says why storage is not durable,
// `durable` is false so a caller does not pretend a write stuck, and the quota gauge carries the
// same reason so a view reading only the gauge still discloses the degradation.

import { RefusalError } from "#renderer/lib/refusal/contract.js";
import type { PersistenceRefusal } from "./refusals.js";
import type { PersistedValueClass } from "./value-classes.js";

/** Which adapter is serving the store. Rendered; never inferred from behavior. */
export type PersistenceAdapterKind = "indexeddb" | "memory";

/** Why the durable adapter is not in use. `undefined` means it is. */
export type PersistenceUnavailableReason =
  | "not-attempted"
  | "no-indexeddb-global"
  | "open-refused"
  | "version-mismatch"
  | "open-timed-out";

/**
 * The sentence each reason renders as. Keyed by every reason, so a reason cannot exist without a
 * sentence for the person. It lives with the seam because the gauge, the health read and the
 * fallback adapter all render it.
 */
export const PERSISTENCE_UNAVAILABLE_DESCRIPTIONS: Readonly<
  Record<PersistenceUnavailableReason, string>
> = {
  "not-attempted": "Durable storage was not requested for this window.",
  "no-indexeddb-global":
    "This window has no database API, which means the renderer scheme was not registered as a " +
    "standard scheme before the app became ready.",
  "open-refused":
    "The browser refused to open the database for this window. That is what a non-privileged " +
    "renderer scheme looks like from here.",
  "version-mismatch":
    "An existing database on disk is newer than this build expects. Nothing has been deleted; a " +
    "newer build of the app will read it.",
  "open-timed-out":
    "Opening the database did not finish in time, usually because another window holds a " +
    "blocking upgrade.",
};

/** One durable record. The partition is the session; the key is scoped within it. */
export interface StoredRecord {
  /** Session id, or `PERSISTENCE_GLOBAL_PARTITION` for window-wide preferences. */
  readonly partition: string;
  readonly key: string;
  readonly valueClass: PersistedValueClass;
  /** Already validated by the chokepoint. An adapter never re-validates. */
  readonly value: unknown;
  /** Epoch milliseconds of the last write. The LRU trim orders on this. */
  readonly updatedAt: number;
}

/** What a partition costs, for the LRU trim and the quota gauge. */
export interface PartitionSummary {
  readonly partition: string;
  readonly recordCount: number;
  readonly newestUpdatedAt: number;
}

/**
 * The storage-pressure reading. `usageBytes` and `quotaBytes` come from
 * `navigator.storage.estimate()` where the browser exposes it; both are absent where it does
 * not, and an absent gauge renders as "not checked", never as zero.
 *
 * `unavailableReason` is required so every producer states whether it is an unmeasurable
 * browser quota or a window with no durable store, which a view reading only the gauge could
 * not otherwise tell apart.
 */
export interface QuotaGauge {
  readonly usageBytes: number | undefined;
  readonly quotaBytes: number | undefined;
  readonly pressure: "ok" | "high" | "unknown";
  /** Why this reading is not from durable storage. `undefined` when it is. */
  readonly unavailableReason: PersistenceUnavailableReason | undefined;
}

/** The seam. Both adapters implement it identically; only durability differs. */
export interface PersistenceAdapter {
  readonly kind: PersistenceAdapterKind;
  /** False for the memory adapter. Callers disclose rather than hide it. */
  readonly durable: boolean;
  /** Present only when `durable` is false. Names what went wrong. */
  readonly unavailableReason: PersistenceUnavailableReason | undefined;
  /** One sentence on why storage is or is not durable. Complete enough to act on. */
  describe(): string;

  read(partition: string, key: string): Promise<StoredRecord | undefined>;
  readPartition(partition: string): Promise<readonly StoredRecord[]>;
  /** Rejects with a `PersistenceAdapterError` on quota exhaustion. */
  write(record: StoredRecord): Promise<void>;
  summarizePartitions(): Promise<readonly PartitionSummary[]>;
  /**
   * Drops least-recently-touched session partitions until at most `keepSessionPartitions`
   * remain, and returns how many were dropped. `PERSISTENCE_GLOBAL_PARTITION` is never a
   * candidate: it holds the window-wide state (the pins, the run filters), which no session's
   * recency speaks for.
   */
  trimPartitions(keepSessionPartitions: number): Promise<number>;
  measureQuota(): Promise<QuotaGauge>;
  close(): void;
}

/**
 * An adapter-level failure, carrying the refusal the store will surface. A `RefusalError`
 * subclass, so it is `isRefusal`-readable without knowing this subtree exists.
 */
export class PersistenceAdapterError extends RefusalError {
  /**
   * Narrowed, not redeclared: `declare` emits no class member, whereas a real field would be
   * defined as `undefined` after `super` ran (`useDefineForClassFields`) and erase the refusal.
   */
  declare public readonly refusal: PersistenceRefusal;

  public constructor(refusal: PersistenceRefusal, options?: { readonly cause?: unknown }) {
    super(refusal, options);
    this.name = "PersistenceAdapterError";
  }
}

/**
 * The partition holding state that belongs to the window rather than one session (the pins, the
 * run filters). A reserved identifier rather than an empty string, so a bug that loses a session
 * id writes somewhere obviously wrong.
 */
export const PERSISTENCE_GLOBAL_PARTITION = "global";

/** True when the reading is a quota problem rather than an ordinary failure. */
export function isQuotaExceeded(error: unknown): boolean {
  if (error instanceof PersistenceAdapterError) {
    return error.refusal.code === "quota-exceeded";
  }
  // `QuotaExceededError` is a DOMException in browsers and a plain error under some polyfills;
  // both carry the name.
  const name = readErrorName(error);
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

/** The `name` a thrown DOMException or error carries, or `undefined` where it carries none. */
export function readErrorName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }
  const name: unknown = error.name;
  return typeof name === "string" ? name : undefined;
}

/**
 * The gauge a caller renders when nothing has been measured. One constructor for every site
 * that produces it, so unmeasurable versus not durable is decided where the reason is supplied.
 */
export function unmeasuredQuota(
  unavailableReason: PersistenceUnavailableReason | undefined,
): QuotaGauge {
  return { usageBytes: undefined, quotaBytes: undefined, pressure: "unknown", unavailableReason };
}
