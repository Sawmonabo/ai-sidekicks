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
//   • **A `useState` initializer, not `useMemo`.** The initializer runs once per
//     mounted component and its result is never recomputed; a memo may be discarded,
//     and a recomputed store would be a second connection nobody closes.
//   • **Closed in the effect's cleanup**, which is the only place that knows the
//     window is actually going away rather than merely re-rendering.
//   • **Re-minted when the state holds a closed store.** React's StrictMode
//     double-mount runs the cleanup and then mounts the SAME component instance
//     again, so the second mount would otherwise be handed the corpse the first
//     one's teardown just closed. Asking the store rather than remembering is what
//     makes that arm correct without a second flag beside it.

import { useEffect, useState } from "react";

import { UiStateStore } from "../persistence/index.js";

/**
 * This window's UI-state store, closed when the console unmounts.
 *
 * One store per mounted console, and exactly one open connection: the re-mint arm
 * replaces a closed store rather than leaving the window writing into one.
 */
export function useUiStateStore(): UiStateStore {
  const [uiStateStore, setUiStateStore] = useState<UiStateStore>(openUiStateStore);
  useEffect(() => {
    if (uiStateStore.isClosed) {
      setUiStateStore(openUiStateStore());
      return;
    }
    return () => {
      // Fired without awaiting: `close` awaits the open it may still be racing, and
      // a cleanup cannot await. The store declares no failure — `openConsoleDatabase`
      // never rejects and neither adapter's `close` throws — so a rejection escaping
      // here would be a defect, and an unhandled one is how it gets found.
      void uiStateStore.close();
    };
  }, [uiStateStore]);
  return uiStateStore;
}

function openUiStateStore(): UiStateStore {
  return UiStateStore.opening();
}
