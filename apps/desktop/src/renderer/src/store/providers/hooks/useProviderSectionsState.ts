// The app's one provider store, read from the feed for as long as the caller is mounted.

import { useCallback, useMemo } from "react";

import type { Unsubscribe } from "#shared/preload-api.js";

import { useSharedFeedState } from "../../hooks/useSharedFeedState.js";
import {
  ProviderSectionsStore,
  type ProviderSectionsFeed,
  type ProviderSectionsState,
} from "../sections.js";

/** The providers' sections as read, and a way to read them again after a failure. */
export interface ProviderSectionsReading {
  readonly state: ProviderSectionsState;
  /** Open the feed afresh, calling `onAnswered` once it has answered; the handle stops the wait. */
  readonly readAgain: (onAnswered: () => void) => Unsubscribe;
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
  const readAgain = useCallback(
    (onAnswered: () => void) => store?.readAgain(onAnswered) ?? NOTHING_TO_STOP,
    [store],
  );
  return useMemo(() => ({ state, readAgain }), [state, readAgain]);
}

/** The handle of a read asked again with no feed open, which never answers. */
const NOTHING_TO_STOP: Unsubscribe = () => undefined;

/** What is read while no feed is open yet. */
const NOT_OPENED: ProviderSectionsState = { status: "reading" };
