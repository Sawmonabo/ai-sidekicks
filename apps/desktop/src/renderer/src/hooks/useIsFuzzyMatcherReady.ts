// Whether the app's fuzzy matcher holds its module, so a list ranked before it arrived is ranked
// again once it does.

import { useSyncExternalStore } from "react";

import { appFuzzyMatcher } from "#renderer/lib/fuzzy-matcher.js";

/** Whether the app's fuzzy matcher scores yet; the component re-renders when it starts to. */
export function useIsFuzzyMatcherReady(): boolean {
  return useSyncExternalStore(appFuzzyMatcher.subscribe, isAppFuzzyMatcherReady);
}

function isAppFuzzyMatcherReady(): boolean {
  return appFuzzyMatcher.isReady;
}
