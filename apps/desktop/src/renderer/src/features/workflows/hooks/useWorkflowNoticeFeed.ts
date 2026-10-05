import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import type { Clock } from "#renderer/lib/clock.js";
import { subscribeWorkflowNotices } from "#renderer/services/daemon/workflow-notices.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { WorkflowNoticeFeed, type WorkflowNoticeFeedState } from "../workflow-notice-feed.js";

/** The screen's one notice feed and where it stands. */
export interface WorkflowNoticeFeedHold {
  readonly feed: WorkflowNoticeFeed;
  readonly state: WorkflowNoticeFeedState;
}

/**
 * Open the machine's workflow stream once for the workflows screen, over this window's bridge,
 * while `isOpen` says something on screen draws from it, and close it when that ends, the screen
 * goes or the bridge is replaced. Closed, the feed stays `opening` and signals nothing. `clock`
 * times the waits between re-opens of a stream that ended.
 */
export function useWorkflowNoticeFeed(
  bridge: PlatformBridge,
  clock: Clock,
  isOpen: boolean,
): WorkflowNoticeFeedHold {
  // `isOpen` keys the feed: each opening takes a fresh one, since a disposed feed never opens
  // again, and a closed one is never started.
  const feed = useMemo(
    () => new WorkflowNoticeFeed((onFrame) => subscribeWorkflowNotices(bridge, clock, onFrame)),
    [bridge, clock, isOpen],
  );
  useEffect(() => {
    if (isOpen) {
      feed.start();
    }
    return () => {
      feed.dispose();
    };
  }, [feed, isOpen]);
  const subscribe = useCallback(
    (onStoreChange: () => void) => feed.onChange(onStoreChange),
    [feed],
  );
  const read = useCallback(() => feed.state, [feed]);
  const state = useSyncExternalStore(subscribe, read, read);
  return { feed, state };
}
