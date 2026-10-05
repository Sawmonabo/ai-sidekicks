import { useCallback, useSyncExternalStore } from "react";

/**
 * A window's location hash, as a subscription to its `hashchange` rather than a poll.
 * It subscribes to no store, so it lives here and not among the frame store selectors.
 */
export function useLocationHash(ownerWindow: Window): string {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      ownerWindow.addEventListener("hashchange", onStoreChange);
      return () => {
        ownerWindow.removeEventListener("hashchange", onStoreChange);
      };
    },
    [ownerWindow],
  );
  const readLocationHash = useCallback(() => ownerWindow.location.hash, [ownerWindow]);
  // The renderer never renders on a server, so the server snapshot is the same reader.
  return useSyncExternalStore(subscribe, readLocationHash, readLocationHash);
}
