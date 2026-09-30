// Who owns this window's durable UI-state store, and what closes it.
//
// `UiStateStore.opening()` returns a store at once while an IndexedDB open proceeds, so first
// paint never waits on storage. An open connection blocks the next version upgrade, so the
// store must be closed when the window goes; a hook owns it because a ref has no teardown.
// The shape matches `useSessionStoreRegistry.ts`: `useSubjectScopedResource` holds the store
// because its clock comes from the bridge and the provider replaces the bridge while the window
// stays mounted, and it closes the store in the effect cleanup and for a render React discards.
// A store closed by a StrictMode-style remount is re-minted through the hook's `isClosed` arm.
// The store runs on the window's clock (`useBridgeClock`), so under the fixture its record
// stamps and the LRU trim ordered on them follow the scenario, not the host.

import { useBridgeClock } from "@renderer/services/platform/hooks/useClock.js";
import { usePlatformBridge } from "@renderer/services/platform/hooks/usePlatformBridge.js";
import { UiStateStore } from "@renderer/store/persistence/ui-state-store.js";
import { useSubjectScopedResource } from "@renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import { type SubjectScopedDisposal } from "@renderer/lib/subject-scoped/subject-scoped-disposal.js";

/**
 * This window's UI-state store, rebuilt on a new bridge and closed when the console unmounts.
 *
 * One store and one open connection per mounted console per bridge. The bridge comes from
 * context so every caller gets the clock the rest of the frame runs on.
 */
export function useUiStateStore(): UiStateStore {
  const bridge = usePlatformBridge();
  const clock = useBridgeClock();
  const { value: uiStateStore } = useSubjectScopedResource<UiStateStore>(
    bridge,
    undefined,
    () => UiStateStore.opening({ clock }),
    UI_STATE_STORE_DISPOSAL,
  );
  return uiStateStore;
}

/**
 * Close one connection, for whichever moment retires this store.
 *
 * Not awaited: `close` awaits the open it may still be racing, and neither a cleanup nor a
 * render can await. The store declares no failure, so a rejection here is a defect and stays
 * unhandled.
 */
function closeUiStateStore(store: UiStateStore): void {
  void store.close();
}

/**
 * How a store ends: it is closed, and a closed one reads as closed.
 *
 * `close` shuts one connection for good, so a remount would write into a dead connection unless
 * the hook can tell a closed store by the store's own `isClosed`. A module-level constant keeps
 * one identity across renders.
 */
const UI_STATE_STORE_DISPOSAL: SubjectScopedDisposal<UiStateStore> = {
  dispose: closeUiStateStore,
  isClosed: (store) => store.isClosed,
};
