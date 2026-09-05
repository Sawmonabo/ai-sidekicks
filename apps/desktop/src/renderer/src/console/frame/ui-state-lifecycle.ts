// Who owns this window's durable UI-state store, and what closes it.
//
// `UiStateStore.opening()` starts an IndexedDB open and hands back a store
// immediately, so first paint never waits on storage. What it does not do — and
// cannot, because it has no idea when the window is finished — is close the
// connection again. A console that mounted, unmounted, and mounted again inside one
// live renderer process therefore left a connection open per mount, and IndexedDB's
// answer to an open connection is to BLOCK the next version upgrade: the store's own
// `close` contract names that exact failure, and nothing was calling it.
//
// So the store is owned by a hook rather than by a ref in a render body. The shape
// is `session-lifecycle.ts`'s, deliberately — same window, same question, and a
// second answer to it would be a second place to get the teardown wrong:
//
//   • **Held by `useSubjectScopedResource`, not by `useState`.** The store's clock comes
//     from the bridge, and the provider replaces that bridge — a reconnect, the
//     fixture's scenario switch — while this window stays mounted. A `useState`
//     initializer runs once and never again, so the replacement was answered by
//     nothing here: the window went on stamping records from a retired scenario's
//     clock and trimming an LRU ordered on those stamps. The holder re-addresses
//     DURING the render that first sees the new bridge, and it mints exactly once per
//     bridge even under the double-invoked render strict mode performs — where a
//     `useState` initializer runs twice and one of the two connections it opens is
//     discarded without ever being closed.
//   • **Closed by the holder's own resource hook**, which owns both moments a
//     connection can be retired: the effect's cleanup, which is the only place that
//     knows the window is going away rather than merely re-rendering and the only
//     place carrying the RETIRED store in its own closure; and the render that drops
//     a store no commit ever saw, which nothing else would ever close. Dropping a
//     value is all a holder does; a connection has to be closed, and the pass that
//     opened one may be a pass React throws away.
//   • **Re-minted when the state holds a closed store.** React's StrictMode
//     double-mount runs the cleanup and then mounts the SAME component instance
//     again, so the second mount would otherwise be handed the corpse the first
//     one's teardown just closed. That arm cannot be a render-phase comparison: the
//     close happens in a cleanup and is invisible to the render before it, so the
//     hook asks the store instead — which is what makes the arm correct without a
//     second flag beside it.
//   • **On the bridge's clock, like every other subsystem this window owns.** The
//     store stamps each record's `updatedAt` from a clock and arms the database
//     open's timeout on the same one, and both defaulted to the wall clock — so
//     under the fixture a record written between two scenario beats carried a
//     timestamp from outside the scenario, and the LRU trim that orders entirely
//     on those stamps ordered on how fast the host was. `consoleClockFor` is the
//     one answer to which clock a window runs on; `session-lifecycle.ts` asks it
//     the same question for the session registry.

import { useEffect } from "react";

import { consoleClockFor, useConsoleBridge, type ConsoleBridge } from "../bridge/index.js";
import { UiStateStore } from "../persistence/index.js";
import { useSubjectScopedResource } from "../store/index.js";

/**
 * This window's UI-state store, rebuilt on a new bridge and closed when the console
 * unmounts.
 *
 * One store per mounted console per bridge, and exactly one open connection at a
 * time: the holder retires the store its bridge was replaced under, and the re-mint
 * arm replaces one that closed itself, rather than leaving the window writing into
 * either.
 *
 * The bridge is resolved from context rather than taken as an argument, for the
 * reason `useSessionStoreRegistry` states one level over: every caller then gets
 * the clock the rest of the frame is running on, and no surface has to thread one
 * through.
 */
export function useUiStateStore(): UiStateStore {
  const bridge = useConsoleBridge();
  const { value: uiStateStore, publish: publishStore } = useSubjectScopedResource<UiStateStore>(
    bridge,
    undefined,
    () => openUiStateStore(bridge),
    closeUiStateStore,
  );
  useEffect(() => {
    if (!uiStateStore.isClosed) {
      return;
    }
    publishStore(openUiStateStore(bridge));
  }, [uiStateStore, publishStore, bridge]);
  return uiStateStore;
}

function openUiStateStore(bridge: ConsoleBridge): UiStateStore {
  return UiStateStore.opening({ clock: consoleClockFor(bridge) });
}

/**
 * Close one connection, for whichever of the two moments retires this store.
 *
 * Fired without awaiting: `close` awaits the open it may still be racing, and neither
 * a cleanup nor a render can await. The store declares no failure —
 * `openConsoleDatabase` never rejects and neither adapter's `close` throws — so a
 * rejection escaping here would be a defect, and an unhandled one is how it gets
 * found.
 *
 * A declared function rather than an arrow at the call site, because the holder is
 * handed it on every render and the render that opens a store is the rare one.
 */
function closeUiStateStore(store: UiStateStore): void {
  void store.close();
}
