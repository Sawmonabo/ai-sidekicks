// The in-memory adapter: what the console uses when there is no durable store.
//
// It is not a stub. It is the whole persistence layer for a renderer whose scheme
// was not registered privileged (I-023-11's failing arm), and for every test that
// wants the store's behaviour without a database. It therefore implements the full
// seam — partitions, LRU trim, a quota gauge — so that a code path exercised only
// under the memory adapter is not a code path nobody ever runs.
//
// The one thing it does differently is tell the truth, and it does so on BOTH read
// models rather than only the prose one: `durable` is false, `describe()` says
// preferences will not survive the window, and every gauge it hands back carries
// the reason it is not durable, so a surface that renders only the gauge still
// discloses the degradation instead of showing three empty numbers.

import { PERSISTENCE_QUOTA_PRESSURE_RATIO } from "../core/index.js";
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
} from "./adapter.js";
import { refusePersistence } from "./value-classes.js";

export interface MemoryPersistenceAdapterOptions {
  /**
   * Why the durable adapter is not in use. `"not-attempted"` is the honest value
   * for a deliberate in-memory construction (a test); anything else came from a
   * real failed open and gets disclosed to the operator.
   */
  readonly unavailableReason?: PersistenceUnavailableReason;
  /**
   * A simulated byte ceiling. Absent means unbounded. Present, the adapter refuses
   * a write that would cross it with the same refusal the durable adapter raises —
   * which is what makes the quota-exhaustion path testable at all.
   */
  readonly capacityBytes?: number;
}

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
    return `Preferences are held in memory for this window only and will not survive a restart. ${reason}`;
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
      const projected = this.#measureUsageBytes(record) + estimateRecordBytes(record);
      if (projected > this.#capacityBytes) {
        return Promise.reject(
          new PersistenceAdapterError(
            refusePersistence(
              "quota-exceeded",
              `writing ${record.valueClass}/${record.key} would take the in-memory store past its ${String(this.#capacityBytes)}-byte ceiling`,
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

  public delete(partition: string, key: string): Promise<void> {
    this.#assertOpen();
    const records = this.#recordsByPartition.get(partition);
    if (records !== undefined) {
      records.delete(key);
      if (records.size === 0) {
        this.#recordsByPartition.delete(partition);
      }
    }
    return Promise.resolve();
  }

  public summarisePartitions(): Promise<readonly PartitionSummary[]> {
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
        total += estimateRecordBytes(record);
      }
    }
    return total;
  }
}

/**
 * A cheap, deterministic size estimate. Not the browser's accounting — this is for
 * the capacity ceiling and the gauge, both of which want a stable number more than
 * an exact one.
 */
function estimateRecordBytes(record: StoredRecord): number {
  return (
    record.partition.length +
    record.key.length +
    record.valueClass.length +
    JSON.stringify(record.value).length
  );
}
