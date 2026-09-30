// The persistence write chokepoint. Every durable write in the console goes through
// `UiStateStore.write`, and no production module but this one imports an adapter.
//
// Four behaviors are decisions rather than mechanics:
//
//   1. Refuse; never repair. A bad address, value class, shape, non-identifier string or
//      over-large record returns a typed refusal and fires the `persistence-value-class`
//      tripwire; the store never truncates or coerces. The address is checked with the value
//      against the same cap, since `partition` and `key` are stored verbatim.
//   2. Trim before failing on quota. A `quota-exceeded` write triggers one LRU partition trim
//      and one retry; a second failure is surfaced. Every adapter failure on the write path
//      surfaces as a returned refusal, since `write` declares its failure as a value.
//   3. Reads never throw, and say which kind of nothing they found. `readOutcome` answers
//      `present`, `absent` or `failed` (counted on health); `read` and `readGlobal` are its
//      lossy projection. A caller that writes back a value derived from an absence, such as a
//      layout restore filing its fallback, takes `readOutcome`.
//   4. The adapter is resolved once, not swapped; see `UiStateStoreOptions.adapter`.
//
// The class decides whether a write lands; classifying and counting refusals is
// `persistence-health.ts`.

import {
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
} from "../persistence-caps.js";
import { RealClock, type Clock } from "@renderer/lib/clock.js";
import {
  PERSISTENCE_GLOBAL_PARTITION,
  PersistenceAdapterError,
  type PersistenceAdapter,
  type QuotaGauge,
  type StoredRecord,
} from "./persistence-adapter.js";
import { validatePersistedAddress } from "./persisted-value-classes.js";
import { MemoryPersistenceAdapter } from "./memory-persistence-adapter.js";
import {
  openUiStateDatabase,
  type OpenUiStateDatabaseOptions,
} from "./indexeddb-persistence-adapter.js";
import {
  PERSISTENCE_READ_ABSENT,
  PERSISTENCE_READ_FAILED,
  recordFromReadOutcome,
  type PersistenceReadOutcome,
} from "./persistence-read-outcome.js";
import { refusePersistence, type PersistenceRefusal } from "./persistence-refusals.js";
import {
  PersistenceHealthTracker,
  REFUSED_ADDRESS_SITE,
  type PersistenceHealth,
} from "./persistence-health.js";
import {
  measureRecordByteLength,
  validatePersistedValue,
  type PersistableValue,
  type PersistedValueClass,
} from "./persisted-value-classes.js";

/** The outcome of a write. A refusal is a value, not an exception. */
export type PersistenceWriteResult =
  | { readonly outcome: "written" }
  | { readonly outcome: "refused"; readonly refusal: PersistenceRefusal };

/** Options for a `UiStateStore`; `adapter` is the only required member. */
export interface UiStateStoreOptions {
  /**
   * The adapter, or a promise for one that is still opening.
   *
   * A promise is admitted so the renderer holds one store identity from its first render while
   * the database opens. Starting on memory and swapping later would lose every write made in
   * between and leave callers that captured the earlier store writing into memory forever.
   */
  readonly adapter: PersistenceAdapter | Promise<PersistenceAdapter>;
  readonly sessionPartitionCap?: number;
  readonly recordByteCap?: number;
  /**
   * The clock every record's `updatedAt` is stamped from. Defaults to `RealClock`, so the LRU
   * trim can be driven on frozen time.
   */
  readonly clock?: Clock;
}

/**
 * The persistence write chokepoint: validates, stores, trims, and reports every refusal as a
 * value. Reads never throw.
 */
export class UiStateStore {
  readonly #adapterReady: Promise<PersistenceAdapter>;
  readonly #sessionPartitionCap: number;
  readonly #recordByteCap: number;
  readonly #clock: Clock;
  readonly #health = new PersistenceHealthTracker();
  #closed = false;

  public constructor(options: UiStateStoreOptions) {
    this.#adapterReady = Promise.resolve(options.adapter);
    this.#sessionPartitionCap = options.sessionPartitionCap ?? PERSISTENCE_SESSION_PARTITION_CAP;
    this.#recordByteCap = options.recordByteCap ?? PERSISTENCE_RECORD_BYTE_CAP;
    this.#clock = options.clock ?? new RealClock();
  }

  /**
   * Builds the store the renderer uses: durable when the privileged scheme gave this window a
   * database, in-memory and saying so when it did not.
   *
   * Synchronous, so the composition root can create it during its first render.
   * `openUiStateDatabase` never throws, so the pending adapter promise cannot reject.
   */
  public static opening(options: OpenUiStateDatabaseOptions = {}): UiStateStore {
    return new UiStateStore({
      adapter: openUiStateDatabase(options).then((outcome) =>
        outcome.outcome === "opened"
          ? outcome.adapter
          : new MemoryPersistenceAdapter({ unavailableReason: outcome.reason }),
      ),
      // The open race and the record stamps share one clock, so a frozen-clock test cannot
      // stop the timeout while records are still stamped off the wall.
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  }

  /**
   * The single durable write path: validates the address, then the value, then the record's
   * size, then persists, then trims. The address goes first because every refusal is reported
   * under a site built from it.
   */
  public async write(
    partition: string,
    key: string,
    valueClass: PersistedValueClass,
    value: PersistableValue,
  ): Promise<PersistenceWriteResult> {
    const addressRefusal = validatePersistedAddress(partition, key);
    if (addressRefusal !== undefined) {
      return this.#refuse(addressRefusal, REFUSED_ADDRESS_SITE);
    }

    const site = `${partition}/${key}`;
    const classRefusal = validatePersistedValue(valueClass, value);
    if (classRefusal !== undefined) {
      return this.#refuse(classRefusal, site);
    }

    const recordByteLength = measureRecordByteLength(partition, key, valueClass, value);
    if (recordByteLength > this.#recordByteCap) {
      return this.#refuse(
        refusePersistence(
          "value-too-large",
          `${valueClass} at ${site} serializes to ${String(recordByteLength)} bytes including its address, past the ${String(this.#recordByteCap)}-byte ceiling for one UI-state record`,
        ),
        site,
      );
    }

    const record: StoredRecord = {
      partition,
      key,
      valueClass,
      value,
      updatedAt: this.#clock.now(),
    };

    const adapter = await this.#adapterReady;
    try {
      await adapter.write(record);
    } catch (error) {
      if (!(error instanceof PersistenceAdapterError) || error.refusal.code !== "quota-exceeded") {
        return this.#refuseAdapterFailure(error, site);
      }
      // One trim, one retry; a second failure is the operator's to see. The trim target is one
      // below what the store holds, since a store at or under its cap would be asked to free
      // nothing and the retry would be the same failure twice. If nothing was freed, the
      // original refusal is surfaced without a second attempt.
      let freedPartitionCount: number;
      try {
        freedPartitionCount = await adapter.trimPartitions(
          Math.max(0, (await this.#countSessionPartitions()) - 1),
        );
      } catch (trimFailure) {
        return this.#refuseAdapterFailure(trimFailure, site);
      }
      this.#health.recordTrim(freedPartitionCount);
      if (freedPartitionCount === 0) {
        return this.#refuse(error.refusal, site);
      }
      try {
        await adapter.write(record);
      } catch (retryFailure) {
        return this.#refuseAdapterFailure(retryFailure, site);
      }
    }

    try {
      await this.#trimIfOverCap();
    } catch (trimFailure) {
      // The record may already be durable, and this arm says "refused" anyway: a store that
      // could not finish validate, persist, trim reports a refusal the operator can count rather
      // than a success that hides a failing store.
      return this.#refuseAdapterFailure(trimFailure, site);
    }
    return { outcome: "written" };
  }

  /** Write a window-wide preference (the color scheme) rather than a session one. */
  public async writeGlobal(
    key: string,
    valueClass: PersistedValueClass,
    value: PersistableValue,
  ): Promise<PersistenceWriteResult> {
    return await this.write(PERSISTENCE_GLOBAL_PARTITION, key, valueClass, value);
  }

  /**
   * The primary read, saying which kind of nothing an absence is. It never throws (a failure
   * is the `failed` arm, counted on the store's health), so a caller deciding what to write
   * on the strength of an absence can tell a record never saved from a read that failed.
   */
  public async readOutcome(partition: string, key: string): Promise<PersistenceReadOutcome> {
    try {
      const record = await (await this.#adapterReady).read(partition, key);
      return record === undefined ? PERSISTENCE_READ_ABSENT : { outcome: "present", record };
    } catch {
      this.#health.recordFailedRead();
      return PERSISTENCE_READ_FAILED;
    }
  }

  /** One window-wide preference, with the same three-answer outcome. */
  public async readGlobalOutcome(key: string): Promise<PersistenceReadOutcome> {
    return await this.readOutcome(PERSISTENCE_GLOBAL_PARTITION, key);
  }

  /**
   * Reads one value. Never throws; a failed read reads as "not loaded", the lossy projection
   * of {@link readOutcome}.
   */
  public async read(partition: string, key: string): Promise<StoredRecord | undefined> {
    return recordFromReadOutcome(await this.readOutcome(partition, key));
  }

  public async readGlobal(key: string): Promise<StoredRecord | undefined> {
    return recordFromReadOutcome(await this.readGlobalOutcome(key));
  }

  /** Every value for one session. Empty on failure, with the failure counted. */
  public async readPartition(partition: string): Promise<readonly StoredRecord[]> {
    try {
      return await (await this.#adapterReady).readPartition(partition);
    } catch {
      this.#health.recordFailedRead();
      return [];
    }
  }

  public async delete(partition: string, key: string): Promise<void> {
    try {
      await (await this.#adapterReady).delete(partition, key);
    } catch {
      this.#health.recordFailedRead();
    }
  }

  /** What the diagnostics view renders. Refreshes the quota gauge. */
  public async health(): Promise<PersistenceHealth> {
    const adapter = await this.#adapterReady;
    this.#health.recordQuota(await adapter.measureQuota());
    return this.#health.snapshot(adapter);
  }

  /** The last gauge read, without touching storage. For a synchronous render. */
  public get lastQuota(): QuotaGauge {
    return this.#health.lastQuota;
  }

  /**
   * True once `close` has been called, so an owner deciding whether to mint a fresh store can
   * ask rather than remember. Teardown and the next mount are two commits, and a closed store
   * is otherwise indistinguishable from a live one.
   */
  public get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Closes the underlying connection. Async because the connection may still be opening, and a
   * synchronous close would leave a late-landing connection open to block the next window's
   * upgrade. The flag is set before the await so `isClosed` is true from the moment close is
   * asked for.
   */
  public async close(): Promise<void> {
    this.#closed = true;
    (await this.#adapterReady).close();
  }

  #refuse(refusal: PersistenceRefusal, site: string): PersistenceWriteResult {
    this.#health.recordRefusal(refusal, site);
    return { outcome: "refused", refusal };
  }

  /**
   * The one translation from a thrown adapter failure into a refused write, used by every arm
   * of the write path because `write` declares its failure as a returned refusal.
   *
   * A failure that is not a `PersistenceAdapterError` is rethrown: both adapters wrap every
   * rejection in one, so anything else is a defect, and refusing it would file the bug under a
   * code naming storage.
   */
  #refuseAdapterFailure(error: unknown, site: string): PersistenceWriteResult {
    if (!(error instanceof PersistenceAdapterError)) {
      throw error;
    }
    return this.#refuse(error.refusal, site);
  }

  async #trimIfOverCap(): Promise<void> {
    if ((await this.#countSessionPartitions()) <= this.#sessionPartitionCap) {
      return;
    }
    this.#health.recordTrim(
      await (await this.#adapterReady).trimPartitions(this.#sessionPartitionCap),
    );
  }

  /** Session partitions only — the global one is never counted and never trimmed. */
  async #countSessionPartitions(): Promise<number> {
    const summaries = await (await this.#adapterReady).summarizePartitions();
    return summaries.filter((summary) => summary.partition !== PERSISTENCE_GLOBAL_PARTITION).length;
  }
}
