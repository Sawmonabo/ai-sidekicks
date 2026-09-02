// The persistence adapter seam, and the honest reasons there are two of them.
//
// `Spec-023 §Console Design (Meridian)` §Persistence on the renderer scheme, which
// is also invariant I-023-11: "IndexedDB is available to the renderer only because
// the custom scheme is registered `standard: true` before `app.ready`; a renderer
// that finds no storage falls back to in-memory state and SAYS SO rather than
// failing opaquely."
//
// So the adapter is not an abstraction for its own sake. It exists because exactly
// one of two things is true at runtime and the console has to be honest about
// which: either the privileged scheme registration landed and there is a durable
// store, or it did not and every preference resets when the window closes. The
// second case is a real degradation and gets a real disclosure — `describe()`
// returns a sentence the diagnostics surface renders, `durable` is false so a
// caller can render "not checked" rather than pretending a write stuck, and the
// quota gauge carries the same reason so a surface reading only the gauge cannot
// report a silent nothing where a degradation belongs.

import { ConsoleRefusalError } from "../core/index.js";
import type { PersistenceRefusal } from "./refusals.js";
import type { PersistedValueClass } from "./value-classes.js";

/** Which adapter is serving the store. Rendered; never inferred from behaviour. */
export type PersistenceAdapterKind = "indexeddb" | "memory";

/**
 * Why the durable adapter is not in use, and the sentence each reason renders as.
 *
 * ONE declaration: the reason vocabulary is the keys of this table, so a reason
 * cannot exist without an operator-facing sentence and a sentence cannot be
 * written for a reason nothing raises. It lives here rather than beside the
 * in-memory adapter because the reason is a property of the SEAM — the gauge, the
 * health read, and the fallback adapter all render it — and a vocabulary owned by
 * one of its three readers is a vocabulary the other two copy.
 */
export const PERSISTENCE_UNAVAILABLE_DESCRIPTIONS = {
  "not-attempted": "Durable storage was not requested for this window.",
  "no-indexeddb-global":
    "This window has no database API, which means the renderer scheme was not registered as a standard scheme before the app became ready.",
  "open-refused":
    "The browser refused to open the database for this window. That is what a non-privileged renderer scheme looks like from here.",
  "version-mismatch":
    "An existing database on disk is newer than this build expects. Nothing has been deleted; a newer build of the app will read it.",
  "open-timed-out":
    "Opening the database did not finish in time, usually because another window holds a blocking upgrade.",
} as const;

/** Why the durable adapter is not in use. `undefined` means it is. */
export type PersistenceUnavailableReason = keyof typeof PERSISTENCE_UNAVAILABLE_DESCRIPTIONS;

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
 * The storage-pressure reading. `usageBytes` / `quotaBytes` come from
 * `navigator.storage.estimate()` where the browser exposes it; both are absent
 * where it does not, and an absent gauge renders as "not checked" rather than as
 * zero — the five kinds of nothing are a design rule, not a nicety.
 *
 * `unavailableReason` is on the gauge rather than only on the adapter because the
 * gauge is what a storage surface reads, and a gauge that reported three absent
 * numbers with no reason would be exactly the "failing opaquely" I-023-11 forbids:
 * a person would see nothing measured and could not tell an unmeasurable browser
 * quota from a window that has no durable store at all. It is required rather than
 * optional so every producer has to state which of the two it is.
 */
export interface QuotaGauge {
  readonly usageBytes: number | undefined;
  readonly quotaBytes: number | undefined;
  readonly pressure: "ok" | "high" | "unknown";
  /** Why this reading is not from durable storage. `undefined` when it is. */
  readonly unavailableReason: PersistenceUnavailableReason | undefined;
}

/**
 * The operator-facing sentence for a gauge whose storage is not durable, or
 * `undefined` when it is.
 *
 * Beside the gauge type so a surface renders the reason through the table that
 * defines it rather than writing its own sentence per reason — which is how two
 * surfaces come to disagree about what `open-timed-out` means.
 */
export function describeQuotaUnavailability(gauge: QuotaGauge): string | undefined {
  return gauge.unavailableReason === undefined
    ? undefined
    : PERSISTENCE_UNAVAILABLE_DESCRIPTIONS[gauge.unavailableReason];
}

/** The seam. Both adapters implement it identically; only durability differs. */
export interface PersistenceAdapter {
  readonly kind: PersistenceAdapterKind;
  /** False for the memory adapter. Callers disclose rather than hide it. */
  readonly durable: boolean;
  /** Present only when `durable` is false. Names what went wrong. */
  readonly unavailableReason: PersistenceUnavailableReason | undefined;
  /** A sentence for the diagnostics surface. Complete and non-technical enough to act on. */
  describe(): string;

  read(partition: string, key: string): Promise<StoredRecord | undefined>;
  readPartition(partition: string): Promise<readonly StoredRecord[]>;
  /** Rejects with a `PersistenceAdapterError` on quota exhaustion. */
  write(record: StoredRecord): Promise<void>;
  delete(partition: string, key: string): Promise<void>;
  summarisePartitions(): Promise<readonly PartitionSummary[]>;
  /**
   * Drop least-recently-touched SESSION partitions until at most
   * `keepSessionPartitions` remain, and return how many were dropped.
   *
   * `PERSISTENCE_GLOBAL_PARTITION` is never a candidate. Ordering by recency
   * would otherwise make it the FIRST casualty — it holds the scheme and the
   * keybindings, written once at boot and then never again, so it is permanently
   * the least recently touched partition in the store.
   */
  trimPartitions(keepSessionPartitions: number): Promise<number>;
  measureQuota(): Promise<QuotaGauge>;
  close(): void;
}

/**
 * An adapter-level failure, carrying the refusal the store will surface.
 *
 * A `ConsoleRefusalError` rather than a second error class doing the same job: the
 * console has one refusal-carrying exception, and an adapter failure caught three
 * layers up is `isConsoleRefusal`-readable without anyone having to know this
 * subtree exists. All this subclass adds is the narrowed refusal type and its own
 * name.
 */
export class PersistenceAdapterError extends ConsoleRefusalError {
  /**
   * Narrowed, not redeclared: the base constructor assigns the field and `declare`
   * emits no class member, so this is a type-level narrowing with no runtime
   * effect. A real field here would be defined as `undefined` after `super` ran
   * (`useDefineForClassFields`) and silently erase the refusal.
   */
  declare public readonly refusal: PersistenceRefusal;

  public constructor(refusal: PersistenceRefusal, options?: { readonly cause?: unknown }) {
    super(refusal, options);
    this.name = "PersistenceAdapterError";
  }
}

/**
 * The partition holding preferences that belong to the window rather than to one
 * session (the colour scheme, the keybinding overrides). Deliberately a reserved
 * identifier rather than an empty string, so a bug that loses a session id writes
 * somewhere obviously wrong instead of silently into the global bucket.
 */
export const PERSISTENCE_GLOBAL_PARTITION = "global";

/**
 * The key the colour scheme occupies inside that partition.
 *
 * Beside the partition rather than beside the store's `writeGlobal`, because
 * partition and key are one address and splitting an address across two modules
 * is how the halves drift. Named at all because a reader and a writer that
 * disagree about a key do not fail — they each work, against different records,
 * and the preference simply never comes back.
 */
export const SCHEME_PREFERENCE_KEY = "scheme";

/** True when the reading is a quota problem rather than an ordinary failure. */
export function isQuotaExceeded(error: unknown): boolean {
  if (error instanceof PersistenceAdapterError) {
    return error.refusal.code === "quota-exceeded";
  }
  // `QuotaExceededError` is a DOMException in browsers and a plain error under
  // some polyfills; both carry the name, and Safari historically used code 22.
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { readonly name: unknown }).name;
    return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
  }
  return false;
}

/**
 * The gauge a caller renders when nothing has been measured.
 *
 * One constructor for the three sites that produce it — both adapters' "the
 * browser told us nothing" arm and the store's pre-first-read value — so the
 * distinction the gauge exists to carry (unmeasurable versus not durable) is made
 * once, at the one place the caller has to supply the reason.
 */
export function unmeasuredQuota(
  unavailableReason: PersistenceUnavailableReason | undefined,
): QuotaGauge {
  return { usageBytes: undefined, quotaBytes: undefined, pressure: "unknown", unavailableReason };
}
