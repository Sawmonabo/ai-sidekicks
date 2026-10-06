// A memory adapter whose reads fail while its writes keep landing.
//
// It is a subclass rather than a hand-written double, so the record map, write path, trim and
// gauge stay the real adapter's and exactly one operation misbehaves. The failure is liftable
// because a read-back taken while reads fail would assert the failure a second time and pass over
// a store that had written anything at all.

import { PersistenceAdapterError, type StoredRecord } from "#renderer/store/persistence/adapter.js";
import { MemoryPersistenceAdapter } from "#renderer/store/persistence/memory-adapter.js";
import { refusePersistence } from "#renderer/store/persistence/refusals.js";

/**
 * A memory persistence adapter whose `read` rejects until `stopFailingReads` is called.
 *
 * It drives the case that separates the store's read answers: `failed` versus nothing stored,
 * and a failed read that must not file a fallback over the record it could not reach.
 */
export class ReadFailurePersistenceAdapter extends MemoryPersistenceAdapter {
  #isFailingReads = true;

  public override read(partition: string, key: string): Promise<StoredRecord | undefined> {
    return this.#isFailingReads
      ? Promise.reject(
          new PersistenceAdapterError(
            refusePersistence(
              "adapter-unavailable",
              "the preferences database dropped its connection mid-read",
            ),
          ),
        )
      : super.read(partition, key);
  }

  /** Let reads work again, so a case can read back what the adapter is holding. */
  public stopFailingReads(): void {
    this.#isFailingReads = false;
  }
}
