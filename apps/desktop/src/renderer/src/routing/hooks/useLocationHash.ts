import { useSyncExternalStore } from "react";

/**
 * The window's location hash, as a subscription to `hashchange` rather than a poll.
 * It subscribes to no store, so it lives here and not among the frame store selectors.
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
