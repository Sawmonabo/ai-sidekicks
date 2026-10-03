import { useSyncExternalStore } from "react";

/**
 * The window's location hash, as a subscription to `hashchange` rather than a poll.
 * It subscribes to no store, so it lives here and not among the frame store selectors.
 */
export function useLocationHash(): string {
  // The renderer never renders on a server, so the server snapshot is the same reader.
  return useSyncExternalStore(subscribeToHashChange, readLocationHash, readLocationHash);
}

function subscribeToHashChange(onStoreChange: () => void): () => void {
  window.addEventListener("hashchange", onStoreChange);
  return () => {
    window.removeEventListener("hashchange", onStoreChange);
  };
}

function readLocationHash(): string {
  return window.location.hash;
}
