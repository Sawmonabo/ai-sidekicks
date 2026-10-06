// The service's session list for as long as the caller is mounted, read from the window's one
// feed (`feeds.ts`), which every view reading the list shares.

import { useCallback, useSyncExternalStore } from "react";

import { sessionDirectoryFeeds } from "./feeds.js";
import type { SessionDirectoryFeed, SessionDirectoryState } from "./state.js";

/**
 * Read the service's session list from `feed` for as long as the caller is mounted: `reading`
 * until the list arrives, then the list as each change leaves it. A replaced feed reads afresh.
 */
export function useSessionDirectory(feed: SessionDirectoryFeed): SessionDirectoryState {
  const watch = useCallback(
    (onChange: () => void) => sessionDirectoryFeeds.watch(feed, onChange),
    [feed],
  );
  const read = useCallback(() => sessionDirectoryFeeds.stateOf(feed), [feed]);
  return useSyncExternalStore(watch, read, read);
}
