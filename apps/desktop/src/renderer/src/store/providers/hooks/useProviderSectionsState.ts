// The app's one provider store, read from the feed for as long as the caller is mounted.

import { useCallback, useMemo } from "react";

import { useSharedFeedState } from "../../hooks/useSharedFeedState.js";
import {
  ProviderSectionsStore,
  type ProviderSectionsFeed,
  type ProviderSectionsState,
} from "../sections.js";

/** The providers' sections as read, and a way to read them again after a failure. */
export interface ProviderSectionsReading {
  readonly state: ProviderSectionsState;
  /** Open the feed afresh; settles once it has answered again. */
  readonly readAgain: () => Promise<void>;
}

/**
 * The providers' sections read from `feed`: `reading` until the list arrives, then the list as
 * each section leaves it. No feed reads nothing yet; a replaced feed reads afresh.
 */
export function useProviderSectionsState(
  feed: ProviderSectionsFeed | undefined,
): ProviderSectionsReading {
  const store = useMemo(
    () => (feed === undefined ? undefined : new ProviderSectionsStore(feed)),
    [feed],
  );
  const state = useSharedFeedState(store, NOT_OPENED);
  const readAgain = useCallback(async () => {
    await store?.readAgain();
  }, [store]);
  return useMemo(() => ({ state, readAgain }), [state, readAgain]);
}

/** What is read while no feed is open yet. */
const NOT_OPENED: ProviderSectionsState = { status: "reading" };
