// The persistence write chokepoint.
//
// Every durable write in the console goes through `UiStateStore.write`. That is the
// whole point of the class: `Spec-023 §Console Design (Meridian)` makes a write
// outside the closed value-class enumeration "a tripwire failure at the store's
// write chokepoint", and a chokepoint that callers can go around is not one. The
// adapters are deliberately not exported from the console's barrel, so the only
// reachable path to a durable byte is this class.
//
// Four behaviours are worth stating because they are decisions rather than
// mechanics:
//
//   1. **Refuse; never repair.** An address that is not identifier-shaped, a
//      disallowed value class, a wrong shape, a string that is not
//      identifier-shaped, an over-large record — each returns a typed refusal and
//      fires the `persistence-value-class` tripwire. The store does not truncate,
//      coerce, or drop a member to make the write fit, because a store that
//      quietly fixes its callers hides the caller that was wrong. The ADDRESS is
//      checked with the value and against the same cap: `partition` and `key` are
//      stored verbatim, so a chokepoint that read only the value would let a
//      caller persist a sentence or a path in the key beside a valid boolean.
//   2. **Trim before failing on quota.** A `quota-exceeded` write triggers one LRU
//      partition trim and one retry. A second failure is surfaced. Retrying forever
//      would turn a full disk into a spin. The trim, the partition count it needs,
//      and the housekeeping trim that follows a successful write all surface an
//      adapter failure as the same refusal the write itself would have returned:
//      `write` declares its failure as a VALUE, and the one shipped caller fires
//      it without awaiting, so a rejection that escapes is an unhandled one.
//   3. **Reads never throw.** A read that fails returns `undefined` and records the
//      failure on the store's health, because a preference the console cannot read
//      is the "not loaded" kind of nothing, not an error the caller must handle.
//   4. **The adapter is resolved once, not swapped.** A store may be constructed
//      around a database that is still opening, and every operation awaits that
//      one resolution. See `UiStateStoreOptions.adapter` for why the alternative —
//      begin on memory, swap in the durable adapter later — loses writes.
//
// The class decides WHETHER a write lands. What that decision meant — whether a
// refusal was the caller's fault or the store's, which of them fires the tripwire,
// and the counts an operator reads afterwards — is `store-health.ts`, held here as
// one field. Two jobs, and the second one is wrong in a way the first cannot be:
// a misfiled refusal sends an operator to audit the wrong half of every write while
// the chokepoint itself behaved perfectly.

import {
  PERSISTENCE_RECORD_BYTE_CAP,
  PERSISTENCE_SESSION_PARTITION_CAP,
  RealClock,
  type ConsoleClock,
} from "../core/index.js";
import {
  PERSISTENCE_GLOBAL_PARTITION,
  PersistenceAdapterError,
  type PersistenceAdapter,
  type QuotaGauge,
  type StoredRecord,
} from "./adapter.js";
import { validatePersistedAddress } from "./identifier-grammar.js";
import { MemoryPersistenceAdapter } from "./memory-adapter.js";
import { openConsoleDatabase, type OpenConsoleDatabaseOptions } from "./indexeddb-adapter.js";
import { refusePersistence, type PersistenceRefusal } from "./refusals.js";
import {
  PersistenceHealthLedger,
  REFUSED_ADDRESS_SITE,
  type PersistenceHealth,
} from "./store-health.js";
import {
  measureRecordByteLength,
  validatePersistedValue,
  type PersistableValue,
  type PersistedValueClass,
} from "./value-classes.js";

/** The outcome of a write. A refusal is a value, not an exception. */
export type PersistenceWriteResult =
  | { readonly outcome: "written" }
  | { readonly outcome: "refused"; readonly refusal: PersistenceRefusal };

export interface UiStateStoreOptions {
  /**
   * The adapter, or a promise for one that is still opening.
   *
   * A promise is admitted so the renderer can hold ONE store identity from its
   * first render while the database opens behind it. The alternative — start on
   * the memory adapter and swap in the durable one when the open settles — loses
   * every write made in between and leaves any caller that captured the earlier
   * store writing into memory forever. Here there is nothing to capture and
   * nothing to swap: each operation awaits the same resolution, and since every
   * operation on this class is already async, no caller pays for the wait.
   */
  readonly adapter: PersistenceAdapter | Promise<PersistenceAdapter>;
  readonly sessionPartitionCap?: number;
  readonly recordByteCap?: number;
  /**
   * The clock every record's `updatedAt` is stamped from. Defaults to `RealClock`.
   *
   * The console's one clock seam rather than a bare `now` callback, so the LRU
   * trim — which orders entirely on these stamps — can be driven on frozen time
   * instead of on whether two writes happened to land in the same millisecond.
   */
  readonly clock?: ConsoleClock;
}

export class UiStateStore {
  readonly #adapterReady: Promise<PersistenceAdapter>;
  readonly #sessionPartitionCap: number;
  readonly #recordByteCap: number;
  readonly #clock: ConsoleClock;
  readonly #health = new PersistenceHealthLedger();
  #closed = false;

  public constructor(options: UiStateStoreOptions) {
    this.#adapterReady = Promise.resolve(options.adapter);
    this.#sessionPartitionCap = options.sessionPartitionCap ?? PERSISTENCE_SESSION_PARTITION_CAP;
    this.#recordByteCap = options.recordByteCap ?? PERSISTENCE_RECORD_BYTE_CAP;
    this.#clock = options.clock ?? new RealClock();
  }

  /**
   * Build the store the renderer actually uses: durable when the privileged scheme
   * gave this window a database, in-memory and SAYING SO when it did not
   * (I-023-11).
   *
   * Synchronous by design — it returns the store, not a promise of one, so the
   * composition root can create it during its first render and hand the same
   * object to every surface. `openConsoleDatabase` is documented never to throw,
   * which is what lets the pending adapter be a promise that cannot reject.
   */
  public static opening(options: OpenConsoleDatabaseOptions = {}): UiStateStore {
    return new UiStateStore({
      adapter: openConsoleDatabase(options).then((outcome) =>
        outcome.outcome === "opened"
          ? outcome.adapter
          : new MemoryPersistenceAdapter({ unavailableReason: outcome.reason }),
      ),
      // The open race and the record stamps share one clock: two clocks here
      // would mean a frozen-clock test could stop the timeout and still be
      // stamping records off the wall.
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
  }

  /**
   * The single durable write path. Validates the address, then the value, then
   * the record's size; then persists, then trims.
   *
   * The address goes first because it is the record's identity: a caller that
   * cannot say WHERE a value belongs has not asked a question the value's
   * validity could answer, and every arm below reports its refusal under a site
   * built from that address — which a refused address may not supply.
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
          `${valueClass} at ${site} serialises to ${String(recordByteLength)} bytes including its address, past the ${String(this.#recordByteCap)}-byte ceiling for one UI-state record`,
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
      // One trim, one retry. A second failure is the operator's to see.
      //
      // The trim target is one BELOW what the store currently holds rather than
      // the standing cap: a store already at or under its cap would otherwise be
      // asked to free nothing, and re-issuing the identical write against an
      // unchanged store is not a retry, it is the same failure twice. If nothing
      // was actually freed, the original refusal is surfaced without the second
      // attempt.
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
      // The record itself may already be durable, and this arm says "refused"
      // anyway. That is the deliberate reading: `write` is documented as
      // validate, then persist, then trim, so a store that could not finish the
      // path it declares reports a refusal the operator can COUNT rather than a
      // success that hides a store which has begun to fail. The alternative —
      // answering "written" and dropping the failure — is the silent one.
      return this.#refuseAdapterFailure(trimFailure, site);
    }
    return { outcome: "written" };
  }

  /** Write a window-wide preference (scheme, keybindings) rather than a session one. */
  public async writeGlobal(
    key: string,
    valueClass: PersistedValueClass,
    value: PersistableValue,
  ): Promise<PersistenceWriteResult> {
    return await this.write(PERSISTENCE_GLOBAL_PARTITION, key, valueClass, value);
  }

  /** Read one value. Never throws: a failed read is "not loaded", not an error. */
  public async read(partition: string, key: string): Promise<StoredRecord | undefined> {
    try {
      return await (await this.#adapterReady).read(partition, key);
    } catch {
      this.#health.recordFailedRead();
      return undefined;
    }
  }

  public async readGlobal(key: string): Promise<StoredRecord | undefined> {
    return await this.read(PERSISTENCE_GLOBAL_PARTITION, key);
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

  /** What the diagnostics surface renders. Refreshes the quota gauge. */
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
   * True once `close` has been called, so an owner that has to decide whether to
   * mint a fresh store can ask rather than remember.
   *
   * The same shape as `SessionStoreRegistry.isDisposed`, and for the same reason:
   * the window's teardown and its next mount are two commits, and a state field
   * holding a store that has been closed is indistinguishable from one holding a
   * live store unless the store itself says which it is.
   */
  public get isClosed(): boolean {
    return this.#closed;
  }

  /**
   * Close the underlying connection.
   *
   * Async because the connection may still be opening: a synchronous close would
   * silently do nothing to a database that lands a millisecond later, leaving a
   * connection open that blocks the next window's upgrade.
   *
   * The flag is set BEFORE the await, so `isClosed` is true from the moment close
   * is asked for. Setting it afterwards would leave a window — as long as the open
   * takes to settle — in which an owner deciding whether to re-mint reads `false`
   * and keeps a store whose connection is already on its way out.
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
   * The one translation from a thrown adapter failure into a refused write.
   *
   * Every arm of the write path funnels through here — the initial write, the
   * post-quota retry, and both trims — because the arms that did not were the
   * arms that REJECTED, and `write`'s declared failure is a returned refusal.
   *
   * A failure that is not a `PersistenceAdapterError` is rethrown rather than
   * refused. Both adapters wrap every rejection in one, so anything else is a
   * defect in this class or in an adapter that broke the seam, and a store that
   * answered "refused" to its own bug would file that bug under a refusal code
   * naming storage — where nobody would ever look for it.
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
    const summaries = await (await this.#adapterReady).summarisePartitions();
    return summaries.filter((summary) => summary.partition !== PERSISTENCE_GLOBAL_PARTITION).length;
  }
}
