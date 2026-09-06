// One way to open a durable store, for every suite in this family.
//
// Five suites in four directories opened a `UiStateStore` over a memory adapter, in
// three different shapes: one taking an adapter a case had already built and wanted
// to keep hold of, two taking an optional byte capacity so a quota case could fill
// it, and two taking nothing at all — plus the inline `new UiStateStore({ adapter })`
// calls a case writes when it needs a SECOND reader over one adapter. The three
// shapes are one role, and a required field landing on the store's own options moved
// five bodies.
//
// TWO ENTRY POINTS, because there are two questions and fusing them would make one
// call ambiguous. A case that only needs somewhere durable to write asks for a store
// and gets a fresh adapter it never names; a case whose whole subject is what
// survives on the adapter — a re-open, a second reader, a quota — holds the adapter
// and opens over it. A single function taking both would have to say what a capacity
// means beside an adapter that already has one.

import { MemoryPersistenceAdapter } from "../persistence/memory-adapter.js";
import { UiStateStore } from "../persistence/index.js";

/**
 * A store over a fresh memory adapter nothing else holds.
 *
 * `capacityBytes` is the quota cases' one knob: left out, the adapter's own default
 * applies and nothing here is near it.
 */
export function openStore(options: { readonly capacityBytes?: number } = {}): UiStateStore {
  return new UiStateStore({
    adapter: new MemoryPersistenceAdapter(
      options.capacityBytes === undefined ? {} : { capacityBytes: options.capacityBytes },
    ),
  });
}

/**
 * A store over an adapter the case already holds.
 *
 * What a re-open case needs: the bytes stay on the adapter, and a second store over
 * the same one reads what the first wrote.
 */
export function openStoreOver(adapter: MemoryPersistenceAdapter): UiStateStore {
  return new UiStateStore({ adapter });
}
