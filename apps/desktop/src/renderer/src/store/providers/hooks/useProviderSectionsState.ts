// The app's one provider store, read from the feed for as long as the caller is mounted.

import { useMemo } from "react";

import { useSharedFeedState } from "../../hooks/useSharedFeedState.js";
import {
  ProviderSectionsStore,
  type ProviderSectionsFeed,
  type ProviderSectionsState,
} from "../sections.js";

/**
 * The providers' sections read from `feed`: `reading` until the list arrives, then the list as
 * each section leaves it. No feed reads nothing yet; a replaced feed reads afresh.
 */
export function useProviderSectionsState(
  feed: ProviderSectionsFeed | undefined,
): ProviderSectionsState {
  const store = useMemo(
    () => (feed === undefined ? undefined : new ProviderSectionsStore(feed)),
    [feed],
  );
  return useSharedFeedState(store, NOT_OPENED);
}

/** What is read while no feed is open yet. */
const NOT_OPENED: ProviderSectionsState = { status: "reading" };
