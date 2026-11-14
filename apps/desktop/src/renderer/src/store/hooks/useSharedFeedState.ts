// A shared feed's state for as long as the caller is mounted and hands one.

import { useCallback, useSyncExternalStore } from "react";

import type { SharedFeed } from "../shared-feed.js";

/**
 * What `feed` holds while the caller is mounted, or `notOpened` while it hands none, which opens
 * no stream.
 */
export function useSharedFeedState<Frame, State>(
  feed: SharedFeed<Frame, State> | undefined,
  notOpened: State,
): State {
  const watch = useCallback(
    (onChange: () => void) => (feed === undefined ? () => undefined : feed.watch(onChange)),
    [feed],
  );
  const read = useCallback(() => feed?.state ?? notOpened, [feed, notOpened]);
  return useSyncExternalStore(watch, read, read);
}
