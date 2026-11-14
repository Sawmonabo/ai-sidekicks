// The skills read from a feed for as long as the caller is mounted and hands one.

import { useCallback, useMemo } from "react";

import { useSharedFeedState } from "../../hooks/useSharedFeedState.js";
import { SkillListStore, type SkillListFeed, type SkillListState } from "../list.js";

/** The skills as read, and a way to read them again after a failure. */
export interface SkillListReading {
  readonly state: SkillListState;
  /** Open the feed afresh; the state stays until the fresh list replaces it. */
  readonly readAgain: () => void;
}

/**
 * The skills read from `feed`: `reading` until the list arrives, then each list as it comes. No
 * feed reads nothing and opens no stream; a replaced feed reads afresh.
 */
export function useSkillListState(feed: SkillListFeed | undefined): SkillListReading {
  const store = useMemo(() => (feed === undefined ? undefined : new SkillListStore(feed)), [feed]);
  const state = useSharedFeedState(store, NOT_OPENED);
  const readAgain = useCallback(() => {
    store?.reread();
  }, [store]);
  return { state, readAgain };
}

/** What is read while no feed is open. */
const NOT_OPENED: SkillListState = { status: "reading" };
