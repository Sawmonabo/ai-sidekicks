// The skills read from a feed for as long as the caller is mounted and hands one.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import { SkillListStore, type SkillListFeed, type SkillListState } from "../list.js";

/**
 * The skills read from `feed`: `reading` until the list arrives, then each list as it comes. No
 * feed reads nothing and opens no stream; a replaced feed reads afresh.
 */
export function useSkillListState(feed: SkillListFeed | undefined): SkillListState {
  const store = useMemo(() => (feed === undefined ? undefined : new SkillListStore(feed)), [feed]);
  const watch = useCallback(
    (onChange: () => void) => (store === undefined ? () => undefined : store.watch(onChange)),
    [store],
  );
  const read = useCallback(() => store?.state ?? NOT_OPENED, [store]);
  return useSyncExternalStore(watch, read, read);
}

/** What is read while no feed is open. */
const NOT_OPENED: SkillListState = { status: "reading" };
