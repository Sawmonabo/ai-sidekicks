// One feed's shared state for as long as the caller is mounted, read from the window's one fold
// of that feed, which every view reading it shares.

import { useCallback, useSyncExternalStore } from "react";

import type { Feed, SharedFeeds } from "../shared-feed.js";

/** What `feeds` holds for `feed` while the caller is mounted; a replaced feed reads afresh. */
export function useSharedFeedsState<Frame, State>(
  feeds: SharedFeeds<Frame, State>,
  feed: Feed<Frame>,
): State {
  const watch = useCallback((onChange: () => void) => feeds.watch(feed, onChange), [feeds, feed]);
  const read = useCallback(() => feeds.stateOf(feed), [feeds, feed]);
  return useSyncExternalStore(watch, read, read);
}
