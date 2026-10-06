import { useCallback, useEffect, useSyncExternalStore } from "react";

import { useSubjectScopedResource } from "#renderer/hooks/subject-scoped/useSubjectScopedResource.js";
import type { Clock } from "#renderer/lib/clock.js";
import { CONTROLLER_DISPOSAL } from "#renderer/lib/subject-scoped/subject-scoped-disposal.js";
import { subscribeWorkflowNotices } from "#renderer/services/daemon/workflow-notices.js";
import type { PlatformBridge } from "#renderer/services/platform/platform-bridge.js";
import { WorkflowNoticeFeed, type WorkflowNoticeFeedState } from "../workflow-notice-feed.js";

/** The screen's one notice feed and where it stands. */
export interface WorkflowNoticeFeedHold {
  readonly feed: WorkflowNoticeFeed;
  readonly state: WorkflowNoticeFeedState;
}

/**
 * The workflows screen's one notice feed over this window's bridge, held for the screen's life so
 * the reads built over it are never rebuilt: its stream is open while `isOpen` says something on
 * screen draws from it and closed otherwise, and the feed is disposed when the screen goes or the
 * bridge is replaced, and made again on a re-mount of the same screen. Closed, it reads `opening`
 * and signals nothing. `clock` times the waits between re-opens of a stream that ended.
 */
export function useWorkflowNoticeFeed(
  bridge: PlatformBridge,
  clock: Clock,
  isOpen: boolean,
): WorkflowNoticeFeedHold {
  const { value: feed } = useSubjectScopedResource(
    bridge,
    undefined,
    () => new WorkflowNoticeFeed((onFrame) => subscribeWorkflowNotices(bridge, clock, onFrame)),
    CONTROLLER_DISPOSAL,
  );
  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    feed.start();
    return () => {
      feed.stop();
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
