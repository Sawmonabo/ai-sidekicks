// One session's agents for as long as the caller is mounted, read from the list every view of
// that session shares.

import { useCallback, useSyncExternalStore } from "react";

import type { SessionId } from "@ai-sidekicks/contracts/session/id";

import {
  sessionAgentLists,
  type SessionAgentListFeed,
  type SessionAgentListState,
} from "../list.js";

/**
 * Read `sessionId`'s agents off `feed`: `reading` until the list arrives, then the list as each
 * agent leaves it. No feed opens nothing and reads `reading`; a replaced feed reads afresh.
 */
export function useSessionAgentList(
  feed: SessionAgentListFeed | undefined,
  sessionId: SessionId,
): SessionAgentListState {
  const watch = useCallback(
    (onChange: () => void) =>
      feed === undefined ? () => undefined : sessionAgentLists.watch(feed, sessionId, onChange),
    [feed, sessionId],
  );
  const read = useCallback(
    () => (feed === undefined ? NOT_OPENED : sessionAgentLists.stateOf(feed, sessionId)),
    [feed, sessionId],
  );
  return useSyncExternalStore(watch, read, read);
}

/** What is read while no feed is open. */
const NOT_OPENED: SessionAgentListState = { status: "reading" };
