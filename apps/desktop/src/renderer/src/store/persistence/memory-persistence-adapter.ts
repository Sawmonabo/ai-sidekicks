// The in-memory adapter: what the console uses when there is no durable store, and for every
// test that wants the store's behavior without a database. It implements the full seam
// (partitions, LRU trim, quota gauge) so no code path runs only under it. It tells the truth on
// both read models: `durable` is false, `describe()` says preferences will not survive the
// window, and every gauge carries the reason it is not durable.

import { PERSISTENCE_QUOTA_PRESSURE_RATIO } from "./caps.js";
import {
  PERSISTENCE_GLOBAL_PARTITION,
  PERSISTENCE_UNAVAILABLE_DESCRIPTIONS,
  PersistenceAdapterError,
  type PartitionSummary,
  type PersistenceAdapter,
  type PersistenceAdapterKind,
  type PersistenceUnavailableReason,
  type QuotaGauge,
  type StoredRecord,
} from "./persistence-adapter.js";
import { measureRecordByteLength } from "./persisted-value-classes.js";
import { refusePersistence } from "./refusals.js";

/** Options for a `MemoryPersistenceAdapter`. */
export interface MemoryPersistenceAdapterOptions {
  /**
   * Why the durable adapter is not in use. `"not-attempted"` is the honest value for a
   * deliberate in-memory construction (a test); anything else came from a failed open and is
   * disclosed to the person.
   */
  readonly unavailableReason?: PersistenceUnavailableReason;
  /**
   * A simulated byte ceiling, absent meaning unbounded. Past it the adapter refuses a write
   * with the durable adapter's refusal, which makes the quota-exhaustion path testable.
   */
  readonly capacityBytes?: number;
}

/** The in-memory implementation of the persistence seam. */
export class MemoryPersistenceAdapter implements PersistenceAdapter {
  public readonly kind: PersistenceAdapterKind = "memory";
  public readonly durable = false;
  public readonly unavailableReason: PersistenceUnavailableReason;

  readonly #recordsByPartition = new Map<string, Map<string, StoredRecord>>();
  readonly #capacityBytes: number | undefined;
  #closed = false;

  public constructor(options: MemoryPersistenceAdapterOptions = {}) {
    this.unavailableReason = options.unavailableReason ?? "not-attempted";
    this.#capacityBytes = options.capacityBytes;
  }

  public describe(): string {
    const reason = PERSISTENCE_UNAVAILABLE_DESCRIPTIONS[this.unavailableReason];
    return (
      `Preferences are held in memory for this window ` +
      `only and will not survive a restart. ${reason}`
    );
  }

  public read(partition: string, key: string): Promise<StoredRecord | undefined> {
    this.#assertOpen();
    return Promise.resolve(this.#recordsByPartition.get(partition)?.get(key));
  }

  public readPartition(partition: string): Promise<readonly StoredRecord[]> {
    this.#assertOpen();
    const records = this.#recordsByPartition.get(partition);
    return Promise.resolve(records === undefined ? [] : [...records.values()]);
  }

  public write(record: StoredRecord): Promise<void> {
    this.#assertOpen();
    if (this.#capacityBytes !== undefined) {
      const projected =
        this.#measureUsageBytes(record) +
        measureRecordByteLength(record.partition, record.key, record.valueClass, record.value);
      if (projected > this.#capacityBytes) {
        return Promise.reject(
          new PersistenceAdapterError(
            refusePersistence(
              "quota-exceeded",
              `writing ${record.valueClass}/${record.key} would take the in-memory ` +
                `store past its ${String(this.#capacityBytes)}-byte ceiling`,
            ),
          ),
        );
      }
    }
    let partition = this.#recordsByPartition.get(record.partition);
    if (partition === undefined) {
      partition = new Map<string, StoredRecord>();
      this.#recordsByPartition.set(record.partition, partition);
    }
    partition.set(record.key, record);
    return Promise.resolve();
  }

  public summarizePartitions(): Promise<readonly PartitionSummary[]> {
    this.#assertOpen();
    const summaries: PartitionSummary[] = [];
    for (const [partition, records] of this.#recordsByPartition) {
      let newestUpdatedAt = 0;
      for (const record of records.values()) {
        newestUpdatedAt = Math.max(newestUpdatedAt, record.updatedAt);
      }
      summaries.push({ partition, recordCount: records.size, newestUpdatedAt });
    }
    return Promise.resolve(summaries);
  }

  public trimPartitions(keepSessionPartitions: number): Promise<number> {
    this.#assertOpen();
    const ordered = [...this.#recordsByPartition.entries()]
      .filter(([partition]) => partition !== PERSISTENCE_GLOBAL_PARTITION)
      .map(([partition, records]) => ({
        partition,
        newestUpdatedAt: Math.max(0, ...[...records.values()].map((record) => record.updatedAt)),
      }))
      .sort((left, right) => right.newestUpdatedAt - left.newestUpdatedAt);
    let removed = 0;
    for (const entry of ordered.slice(Math.max(0, keepSessionPartitions))) {
      this.#recordsByPartition.delete(entry.partition);
      removed += 1;
    }
    return Promise.resolve(removed);
  }

  public measureQuota(): Promise<QuotaGauge> {
    this.#assertOpen();
    const usageBytes = this.#measureUsageBytes();
    if (this.#capacityBytes === undefined) {
      return Promise.resolve({
        usageBytes,
        quotaBytes: undefined,
        pressure: "unknown",
        unavailableReason: this.unavailableReason,
      });
    }
    return Promise.resolve({
      usageBytes,
      quotaBytes: this.#capacityBytes,
      pressure:
        usageBytes / this.#capacityBytes >= PERSISTENCE_QUOTA_PRESSURE_RATIO ? "high" : "ok",
      unavailableReason: this.unavailableReason,
    });
  }

  public close(): void {
    this.#closed = true;
    this.#recordsByPartition.clear();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new PersistenceAdapterError(
        refusePersistence(
          "adapter-unavailable",
          "the in-memory persistence adapter was closed; the window is tearing down",
        ),
      );
    }
  }

  #measureUsageBytes(excluding?: StoredRecord): number {
    let total = 0;
    for (const records of this.#recordsByPartition.values()) {
      for (const record of records.values()) {
        if (
          excluding !== undefined &&
          record.partition === excluding.partition &&
          record.key === excluding.key
        ) {
          continue;
        }
        total += measureRecordByteLength(
          record.partition,
          record.key,
          record.valueClass,
          record.value,
        );
      }
    }
    return total;
  }
}
