// The app's fuzzy matcher as a list it ranks reads it: where its module's load stands, so a list
// drawn unranked before it arrived is ranked once it does, and the ask that loads it again after
// its load failed.

import { useSyncExternalStore } from "react";

import { markdownWorker } from "#renderer/components/Markdown/worker/connection.js";
import type { PageModuleState } from "#renderer/components/Markdown/worker/page-module-load.js";

/** Where the matcher's module stands, and the ask that loads it again. */
export interface FuzzyMatcherLoad {
  readonly state: PageModuleState;
  readonly loadAgain: () => void;
}

/** The app's fuzzy matcher's load; the component re-renders as it moves. */
export function useFuzzyMatcher(): FuzzyMatcherLoad {
  const state = useSyncExternalStore(markdownWorker.fuzzyMatcher.subscribe, readMatcherState);
  return { state, loadAgain: loadMatcherAgain };
}

function readMatcherState(): PageModuleState {
  return markdownWorker.fuzzyMatcher.state;
}

function loadMatcherAgain(): void {
  markdownWorker.wantFuzzyMatcher();
}
