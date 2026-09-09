// The window's location hash, as a subscription rather than a poll.
//
// ITS OWN MODULE AND NOT A FRAME-STORE HOOK, because it subscribes to no store at
// all: it reads the browser's own `hashchange` event. It sits in `shell/` because
// the frame is what binds it — `frame/bindings/hash-route-binding.ts` is the reader that
// turns a hash into the route the shell renders — and a subscription with no store
// filed among the frame store's selectors would read as one of them.

import { useSyncExternalStore } from "react";

/**
 * The window's location hash, as a subscription rather than a poll.
 *
 * `hashchange` is a real browser event, so this needs no interval — which matters,
 * because a 100 ms route poll would be the console's only always-on timer and would
 * blow the idle-CPU budget on its own.
 */
export function useLocationHash(): string {
  return useSyncExternalStore(subscribeToHashChange, readLocationHash, readServerLocationHash);
}

function subscribeToHashChange(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener("hashchange", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
  };
}

function readLocationHash(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

function readServerLocationHash(): string {
  return "";
}
