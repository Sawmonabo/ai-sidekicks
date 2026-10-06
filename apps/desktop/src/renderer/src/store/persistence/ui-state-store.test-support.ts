// One way to open a durable store for every suite that writes through `UiStateStore`. `openStore`
// is for a case that only needs somewhere durable to write; `openStoreOver` is for a case whose
// subject is what survives on an adapter it holds (a re-open, a second reader).

import { MemoryPersistenceAdapter } from "#renderer/store/persistence/memory-adapter.js";
import { UiStateStore } from "#renderer/store/persistence/ui-state-store.js";

/** A store over a fresh memory adapter. `capacityBytes` sets the quota for quota cases. */
export function openStore(options: { readonly capacityBytes?: number } = {}): UiStateStore {
  return new UiStateStore({
    adapter: new MemoryPersistenceAdapter(
      options.capacityBytes === undefined ? {} : { capacityBytes: options.capacityBytes },
    ),
  });
}

/** A store over an adapter the case already holds, so a second store reads what the first wrote. */
export function openStoreOver(adapter: MemoryPersistenceAdapter): UiStateStore {
  return new UiStateStore({ adapter });
}
