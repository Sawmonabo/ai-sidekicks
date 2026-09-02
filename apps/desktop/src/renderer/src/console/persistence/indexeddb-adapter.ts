// The durable adapter, and the four ways opening it can fail.
//
// `Spec-023 §Console Libraries` gives the `idb` row as ADOPT: a thin promise
// wrapper over IndexedDB, chosen over a key-value abstraction because the console
// wants the index and the cursor, not a `get`/`set` façade over them.
//
// Opening is the interesting part. Every one of these is reachable in a shipped
// Electron app and each needs a DIFFERENT answer, which is why `openConsoleDatabase`
// returns a discriminated reason rather than a boolean:
//
//   • no `indexedDB` global — the renderer scheme was not registered `standard`,
//     I-023-11's failing arm;
//   • the open is refused (`SecurityError`) — same cause, different symptom
//     depending on the Chromium build;
//   • a `VersionError` — a NEWER build of the app already wrote this database.
//     Deleting it to "recover" would destroy a future version's state, so the
//     adapter degrades to memory and leaves the bytes alone;
//   • the open never settles — another window holds a blocking upgrade. A promise
//     that never resolves would hang the console's first paint behind storage, so
//     the open is raced against a bounded timeout and loses gracefully.
//
// Quota exhaustion is separate and happens at WRITE time, not open time, so it
// surfaces as a typed refusal on the write rather than as a failed construction.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import {
  PERSISTENCE_QUOTA_PRESSURE_RATIO,
  RealClock,
  type ConsoleClock,
  type ScheduledHandle,
} from "../core/index.js";
import {
  PERSISTENCE_GLOBAL_PARTITION,
  PersistenceAdapterError,
  isQuotaExceeded,
  unmeasuredQuota,
  type PartitionSummary,
  type PersistenceAdapter,
  type PersistenceAdapterKind,
  type PersistenceUnavailableReason,
  type QuotaGauge,
  type StoredRecord,
} from "./adapter.js";
import { refusePersistence } from "./refusals.js";

/** The database this build reads and writes. Bumping the version is a migration. */
export const CONSOLE_DATABASE_NAME = "sidekicks-console-ui-state";
export const CONSOLE_DATABASE_VERSION = 1;
export const UI_STATE_STORE_NAME = "ui-state";

/** How long the console will wait for a database before rendering without one. */
export const DATABASE_OPEN_TIMEOUT_MS = 3000;

interface ConsoleDatabaseSchema extends DBSchema {
  [UI_STATE_STORE_NAME]: {
    key: [string, string];
    value: StoredRecord;
    indexes: {
      "by-partition": string;
      "by-updated-at": number;
    };
  };
}

/** What `openConsoleDatabase` returns: a usable adapter, or the reason there is none. */
export type DatabaseOpenOutcome =
  | { readonly outcome: "opened"; readonly adapter: IndexedDbPersistenceAdapter }
  | {
      readonly outcome: "unavailable";
      readonly reason: PersistenceUnavailableReason;
      readonly cause?: unknown;
    };

export interface OpenConsoleDatabaseOptions {
  readonly databaseName?: string;
  readonly openTimeoutMs?: number;
  /**
   * The factory whose PRESENCE — the property's, not the value's — decides
   * whether a durable open is attempted at all.
   *
   * Omitting the key falls back to the ambient `indexedDB` global. Supplying
   * `undefined` EXPLICITLY means "this host has none" and drives the
   * `no-indexeddb-global` arm, which is why `resolveIndexedDbFactory` asks
   * whether the key is there rather than coalescing its value: `?? indexedDB`
   * substitutes the ambient factory for an explicit `undefined`, so that arm
   * would be unreachable on any host that HAS a global — which is every browser,
   * and every test that installs one.
   *
   * The `| undefined` in the type is load-bearing rather than decorative: under
   * `exactOptionalPropertyTypes` it is what makes `{ indexedDbFactory: undefined }`
   * a call the compiler admits at all.
   *
   * Deliberately not the handle the open runs against: `idb`'s `openDB` reads the
   * global itself and exposes no factory parameter, so this option gates the
   * attempt rather than redirecting it. Saying so here because a reader who
   * assumed otherwise would write a test that believes it is driving an injected
   * database and is really driving the ambient one.
   */
  readonly indexedDbFactory?: IDBFactory | undefined;
  /** Injected for tests; defaults to `navigator.storage`. */
  readonly storageManager?: StorageManager | undefined;
  /**
   * The clock the open timeout is armed on. Defaults to `RealClock`.
   *
   * A seam rather than a bare `setTimeout` for the same reason every other timer
   * in the console is one: the open race is the only timer this family arms, and
   * a timer that cannot be counted cannot be part of the "no timer fires except
   * the refresh scheduler's deadline" claim. It also makes the timeout arm
   * testable in milliseconds of frozen time rather than in three real seconds.
   */
  readonly clock?: ConsoleClock;
}

/**
 * The factory this open is gated on, distinguishing an OMITTED option from one
 * explicitly supplied as `undefined`.
 *
 * See `OpenConsoleDatabaseOptions.indexedDbFactory` for why the distinction is the
 * contract rather than a nicety.
 */
function resolveIndexedDbFactory(options: OpenConsoleDatabaseOptions): IDBFactory | undefined {
  if ("indexedDbFactory" in options) {
    return options.indexedDbFactory;
  }
  return typeof indexedDB === "undefined" ? undefined : indexedDB;
}

/**
 * Attempt the durable open. Never throws: the failure modes above are outcomes the
 * caller renders, not exceptions it swallows.
 */
export async function openConsoleDatabase(
  options: OpenConsoleDatabaseOptions = {},
): Promise<DatabaseOpenOutcome> {
  const indexedDbFactory = resolveIndexedDbFactory(options);
  if (indexedDbFactory === undefined) {
    return { outcome: "unavailable", reason: "no-indexeddb-global" };
  }

  const databaseName = options.databaseName ?? CONSOLE_DATABASE_NAME;
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
    const opening = openDB<ConsoleDatabaseSchema>(databaseName, CONSOLE_DATABASE_VERSION, {
      upgrade(database) {
        const store = database.createObjectStore(UI_STATE_STORE_NAME, {
          keyPath: ["partition", "key"],
        });
        store.createIndex("by-partition", "partition");
        store.createIndex("by-updated-at", "updatedAt");
      },
    });
    const settled = await Promise.race([opening, timeout]);
    if (settled === timedOut) {
      // The open may still land later. Close it when it does rather than leaking a
      // connection that would block the NEXT window's upgrade.
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
 * Map an open failure to its reason.
 *
 * Exported because the three failures reach it by different routes — Chromium
 * throws `SecurityError` synchronously on an opaque origin, while `VersionError`
 * arrives on the request's `error` event — and a test that could only drive one
 * route would leave the other two classifications unasserted.
 */
export function classifyOpenFailure(error: unknown): PersistenceUnavailableReason {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { readonly name: unknown }).name;
    if (name === "VersionError") {
      return "version-mismatch";
    }
    if (name === "SecurityError" || name === "InvalidStateError" || name === "UnknownError") {
      return "open-refused";
    }
  }
  return "open-refused";
}

export class IndexedDbPersistenceAdapter implements PersistenceAdapter {
  public readonly kind: PersistenceAdapterKind = "indexeddb";
  public readonly durable = true;
  public readonly unavailableReason: PersistenceUnavailableReason | undefined = undefined;

  readonly #database: IDBPDatabase<ConsoleDatabaseSchema>;
  readonly #storageManager: StorageManager | undefined;

  public constructor(
    database: IDBPDatabase<ConsoleDatabaseSchema>,
    storageManager?: StorageManager | undefined,
  ) {
    this.#database = database;
    this.#storageManager =
      storageManager ??
      (typeof navigator === "undefined"
        ? undefined
        : (navigator.storage as StorageManager | undefined));
  }

  public describe(): string {
    return `Preferences are stored on this machine (${this.#database.name} v${String(this.#database.version)}) and survive a restart.`;
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

  public async delete(partition: string, key: string): Promise<void> {
    await this.#guard(async () => {
      await this.#database.delete(UI_STATE_STORE_NAME, [partition, key]);
    });
  }

  public async summarisePartitions(): Promise<readonly PartitionSummary[]> {
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
    const summaries = await this.summarisePartitions();
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
    // Every arm carries `unavailableReason: undefined` — this adapter IS the
    // durable one, so an unmeasurable browser quota here means "the browser told
    // us nothing", never "there is no durable store". That is exactly the
    // distinction a surface reading three absent numbers cannot make on its own.
    if (this.#storageManager === undefined || typeof this.#storageManager.estimate !== "function") {
      // Not "zero used" — unknown. The five kinds of nothing are distinct.
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
            "the browser storage quota for this window is full; older sessions' preferences are trimmed first, then the write is retried once",
          ),
          { cause: error },
        );
      }
      throw new PersistenceAdapterError(
        refusePersistence(
          "adapter-unavailable",
          `the preferences database rejected an operation (${describeError(error)})`,
        ),
        { cause: error },
      );
    }
  }
}

function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    const name = (error as { readonly name: unknown }).name;
    if (typeof name === "string") {
      return name;
    }
  }
  return "unknown error";
}
