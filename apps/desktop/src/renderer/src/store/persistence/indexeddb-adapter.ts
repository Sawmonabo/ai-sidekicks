// The durable adapter, built on `idb` (a thin promise wrapper) because the console wants the
// index and the cursor, not a `get`/`set` façade.
//
// `openUiStateDatabase` returns a discriminated reason rather than a boolean, because each way
// the open fails needs a different answer:
//
//   - no `indexedDB` global: the renderer scheme was not registered `standard`;
//   - the open is refused (`SecurityError`): same cause, different symptom by Chromium build;
//   - a `VersionError`: a newer build already wrote this database. Deleting it would destroy
//     that state, so the adapter degrades to memory and leaves the bytes alone;
//   - the open never settles because another window holds a blocking upgrade. It is raced
//     against a bounded timeout so first paint never hangs behind storage.
//
// Quota exhaustion happens at write time and surfaces as a typed refusal on the write.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { PERSISTENCE_QUOTA_PRESSURE_RATIO } from "./caps.js";
import { RealClock, type Clock, type ScheduledHandle } from "#renderer/lib/clock.js";
import {
  PERSISTENCE_GLOBAL_PARTITION,
  PersistenceAdapterError,
  isQuotaExceeded,
  readErrorName,
  unmeasuredQuota,
  type PartitionSummary,
  type PersistenceAdapter,
  type PersistenceAdapterKind,
  type PersistenceUnavailableReason,
  type QuotaGauge,
  type StoredRecord,
} from "./adapter.js";
import { refusePersistence } from "./refusals.js";

/** The database this build reads and writes; bumping the version is a migration. */
export const UI_STATE_DATABASE_NAME = "sidekicks-ui-state";
/** The schema version of the database. */
export const UI_STATE_DATABASE_VERSION = 1;
/** The object store that holds every UI-state record. */
export const UI_STATE_STORE_NAME = "ui-state";

/** How long the console will wait for a database before rendering without one. */
export const DATABASE_OPEN_TIMEOUT_MS = 3000;

/** What `openUiStateDatabase` returns: a usable adapter, or the reason there is none. */
export type DatabaseOpenOutcome =
  | { readonly outcome: "opened"; readonly adapter: IndexedDbPersistenceAdapter }
  | {
      readonly outcome: "unavailable";
      readonly reason: PersistenceUnavailableReason;
      readonly cause?: unknown;
    };

/** Options for `openUiStateDatabase`; each exists so a test can drive one failure arm. */
export interface OpenUiStateDatabaseOptions {
  readonly databaseName?: string;
  readonly openTimeoutMs?: number;
  /**
   * The factory whose presence (the property's, not the value's) decides whether a durable
   * open is attempted. Omitting the key uses the ambient `indexedDB` global; supplying
   * `undefined` explicitly means this host has none and drives the `no-indexeddb-global` arm,
   * which is why `resolveIndexedDbFactory` tests for the key rather than coalescing the value.
   * The `| undefined` is what lets `exactOptionalPropertyTypes` admit that call.
   *
   * It gates the attempt and does not redirect it: `idb`'s `openDB` reads the global itself.
   */
  readonly indexedDbFactory?: IDBFactory | undefined;
  /** Injected for tests; defaults to `navigator.storage`. */
  readonly storageManager?: StorageManager | undefined;
  /**
   * The clock the open timeout is armed on. Defaults to `RealClock`, and lets the timeout arm
   * run in milliseconds of frozen time rather than three real seconds.
   */
  readonly clock?: Clock;
}

/** The IndexedDB implementation of the persistence seam. */
export class IndexedDbPersistenceAdapter implements PersistenceAdapter {
  public readonly kind: PersistenceAdapterKind = "indexeddb";
  public readonly durable = true;
  public readonly unavailableReason: PersistenceUnavailableReason | undefined = undefined;

  readonly #database: IDBPDatabase<UiStateDatabaseSchema>;
  readonly #storageManager: StorageManager | undefined;

  public constructor(
    database: IDBPDatabase<UiStateDatabaseSchema>,
    storageManager?: StorageManager | undefined,
  ) {
    this.#database = database;
    this.#storageManager = storageManager ?? (navigator.storage as StorageManager | undefined);
  }

  public describe(): string {
    return (
      `Preferences are stored (${this.#database.name} ` +
      `v${String(this.#database.version)}) and survive a restart.`
    );
  }

  public async read(partition: string, key: string): Promise<StoredRecord | undefined> {
    return await this.#guard(
      async () => await this.#database.get(UI_STATE_STORE_NAME, [partition, key]),
    );
  }

  public async readPartition(partition: string): Promise<readonly StoredRecord[]> {
    return await this.#guard(
      async () =>
        await this.#database.getAllFromIndex(UI_STATE_STORE_NAME, "by-partition", partition),
    );
  }

  public async write(record: StoredRecord): Promise<void> {
    await this.#guard(async () => {
      await this.#database.put(UI_STATE_STORE_NAME, record);
    });
  }

  public async summarizePartitions(): Promise<readonly PartitionSummary[]> {
    return await this.#guard(async () => {
      const summariesByPartition = new Map<
        string,
        { recordCount: number; newestUpdatedAt: number }
      >();
      let cursor = await this.#database.transaction(UI_STATE_STORE_NAME).store.openCursor();
      while (cursor !== null) {
        const record = cursor.value;
        const existing = summariesByPartition.get(record.partition);
        if (existing === undefined) {
          summariesByPartition.set(record.partition, {
            recordCount: 1,
            newestUpdatedAt: record.updatedAt,
          });
        } else {
          existing.recordCount += 1;
          existing.newestUpdatedAt = Math.max(existing.newestUpdatedAt, record.updatedAt);
        }
        cursor = await cursor.continue();
      }
      return [...summariesByPartition].map(([partition, summary]) => ({ partition, ...summary }));
    });
  }

  public async trimPartitions(keepSessionPartitions: number): Promise<number> {
    const summaries = await this.summarizePartitions();
    const doomed = summaries
      .filter((summary) => summary.partition !== PERSISTENCE_GLOBAL_PARTITION)
      .sort((left, right) => right.newestUpdatedAt - left.newestUpdatedAt)
      .slice(Math.max(0, keepSessionPartitions));
    if (doomed.length === 0) {
      return 0;
    }
    await this.#guard(async () => {
      const transaction = this.#database.transaction(UI_STATE_STORE_NAME, "readwrite");
      const index = transaction.store.index("by-partition");
      for (const summary of doomed) {
        let cursor = await index.openCursor(IDBKeyRange.only(summary.partition));
        while (cursor !== null) {
          await cursor.delete();
          cursor = await cursor.continue();
        }
      }
      await transaction.done;
    });
    return doomed.length;
  }

  public async measureQuota(): Promise<QuotaGauge> {
    // Every arm carries `unavailableReason: undefined`: this adapter is the durable one, so an
    // unmeasurable quota means "the browser told us nothing", never "no durable store".
    if (this.#storageManager === undefined || typeof this.#storageManager.estimate !== "function") {
      // Not "zero used": unknown.
      return unmeasuredQuota(undefined);
    }
    try {
      const estimate = await this.#storageManager.estimate();
      const usageBytes = estimate.usage;
      const quotaBytes = estimate.quota;
      if (usageBytes === undefined || quotaBytes === undefined || quotaBytes === 0) {
        return { usageBytes, quotaBytes, pressure: "unknown", unavailableReason: undefined };
      }
      return {
        usageBytes,
        quotaBytes,
        pressure: usageBytes / quotaBytes >= PERSISTENCE_QUOTA_PRESSURE_RATIO ? "high" : "ok",
        unavailableReason: undefined,
      };
    } catch {
      return unmeasuredQuota(undefined);
    }
  }

  public close(): void {
    this.#database.close();
  }

  async #guard<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    try {
      return await operation();
    } catch (error) {
      if (isQuotaExceeded(error)) {
        throw new PersistenceAdapterError(
          refusePersistence(
            "quota-exceeded",
            "the browser storage quota for this window is full; older sessions' " +
              "preferences are trimmed first, then the write is retried once",
          ),
          { cause: error },
        );
      }
      throw new PersistenceAdapterError(
        refusePersistence(
          "adapter-unavailable",
          `the preferences database rejected an operation ` +
            `(${readErrorName(error) ?? "unknown error"})`,
        ),
        { cause: error },
      );
    }
  }
}

/** Attempts the durable open. Never throws: each failure mode is an outcome the caller renders. */
export async function openUiStateDatabase(
  options: OpenUiStateDatabaseOptions = {},
): Promise<DatabaseOpenOutcome> {
  const indexedDbFactory = resolveIndexedDbFactory(options);
  if (indexedDbFactory === undefined) {
    return { outcome: "unavailable", reason: "no-indexeddb-global" };
  }

  const databaseName = options.databaseName ?? UI_STATE_DATABASE_NAME;
  const openTimeoutMs = options.openTimeoutMs ?? DATABASE_OPEN_TIMEOUT_MS;
  const clock = options.clock ?? new RealClock();

  let timeoutHandle: ScheduledHandle | undefined;
  const timedOut = Symbol("database-open-timed-out");
  const timeout = new Promise<typeof timedOut>((resolve) => {
    timeoutHandle = clock.scheduleTimeout(() => {
      resolve(timedOut);
    }, openTimeoutMs);
  });

  try {
    const opening = openDB<UiStateDatabaseSchema>(databaseName, UI_STATE_DATABASE_VERSION, {
      upgrade(database) {
        const store = database.createObjectStore(UI_STATE_STORE_NAME, {
          keyPath: ["partition", "key"],
        });
        store.createIndex("by-partition", "partition");
      },
    });
    const settled = await Promise.race([opening, timeout]);
    if (settled === timedOut) {
      // The open may still land later; close it then, or the connection blocks the next window's
      // upgrade.
      void opening.then(
        (database) => {
          database.close();
        },
        () => undefined,
      );
      return { outcome: "unavailable", reason: "open-timed-out" };
    }
    return {
      outcome: "opened",
      adapter: new IndexedDbPersistenceAdapter(settled, options.storageManager),
    };
  } catch (error) {
    return { outcome: "unavailable", reason: classifyOpenFailure(error), cause: error };
  } finally {
    if (timeoutHandle !== undefined) {
      clock.cancel(timeoutHandle);
    }
  }
}

/**
 * Maps an open failure to its reason. Only a newer database on disk has a reason of its own;
 * every other failure (Chromium's synchronous `SecurityError` on an opaque origin among them) is
 * a refused open.
 */
function classifyOpenFailure(error: unknown): PersistenceUnavailableReason {
  return readErrorName(error) === "VersionError" ? "version-mismatch" : "open-refused";
}

interface UiStateDatabaseSchema extends DBSchema {
  [UI_STATE_STORE_NAME]: {
    key: [string, string];
    value: StoredRecord;
    indexes: {
      "by-partition": string;
    };
  };
}

/**
 * The factory this open is gated on, distinguishing an omitted option from one explicitly
 * supplied as `undefined`; see `OpenUiStateDatabaseOptions.indexedDbFactory`.
 */
function resolveIndexedDbFactory(options: OpenUiStateDatabaseOptions): IDBFactory | undefined {
  if ("indexedDbFactory" in options) {
    return options.indexedDbFactory;
  }
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}
