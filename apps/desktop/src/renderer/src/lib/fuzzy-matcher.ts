// The app's one fuzzy matcher, which the palette, Settings search and the keyboard page rank with.
// It scores nothing until the markdown worker compiles its module and the worker's connection
// hands it over, since the page compiles no WebAssembly itself; the app wakes that worker as it
// starts, so the module is in hand before a person types.

import { FuzzyMatcher } from "@ai-sidekicks/search-ranking";

/** The app's matcher, which the markdown worker's connection provides with the module it posts. */
export const appFuzzyMatcher: FuzzyMatcher = new FuzzyMatcher();
