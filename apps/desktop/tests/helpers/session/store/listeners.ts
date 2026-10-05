// Counts the listeners a session store still holds. A disposed owner usually also stops acting
// on what it hears, so a listener it forgot to release shows nothing from outside; a leak test
// counts it here instead.

import { vi } from "vitest";

import type { SessionStore } from "#renderer/store/session/session-store.js";

/**
 * Wraps `store.readable` so every later subscription is counted until it is released. Call it
 * before the owner subscribes; the returned function reads how many are still live.
 */
export function countStoreListeners(store: SessionStore): () => number {
  const readable = store.readable;
  let liveListeners = 0;
  vi.spyOn(store, "readable", "get").mockReturnValue({
    ...readable,
    subscribe: (listener) => {
      const unsubscribe = readable.subscribe(listener);
      liveListeners += 1;
      return () => {
        liveListeners -= 1;
        unsubscribe();
      };
    },
  });
  return () => liveListeners;
}
