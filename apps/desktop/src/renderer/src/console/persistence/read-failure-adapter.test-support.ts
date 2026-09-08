// A memory adapter whose reads fail while its writes keep landing.
//
// The collaborator two suites need to drive the one case that separates the store's
// three read answers: the store's own cases prove `readOutcome` reports `failed` where
// `read` reported nothing, and the deck's restore-order cases prove a failed read does
// not file a fallback over the record it could not reach. Written once because both
// need the same misbehaviour, and it is a SUBCLASS rather than a hand-written double
// for `ui-state-store.adapter-failure.test.ts`'s reason: the record map, the write
// path, the trim and the gauge stay the real adapter's, so exactly one operation
// misbehaves.
//
// AND THE FAILURE IS LIFTABLE, because every case that asserts what the adapter still
// HOLDS has to read it back through the same adapter — a read-back taken while reads
// fail asserts the failure a second time and would pass over a store that had written
// anything at all.

import { PersistenceAdapterError, type StoredRecord } from "./adapter.js";
import { MemoryPersistenceAdapter } from "./memory-adapter.js";
import { refusePersistence } from "./refusals.js";

export class ReadFailureAdapter extends MemoryPersistenceAdapter {
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
