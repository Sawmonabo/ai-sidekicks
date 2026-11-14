// The one line a list the app's fuzzy matcher ranks draws when the matcher's module failed to
// load: `Search failed`, with `Try again` asking for the module again. While it loads, or once it
// runs, nothing is drawn.

import type { FuzzyMatcherLoad } from "#renderer/hooks/useFuzzyMatcher.js";
import { InlineRefusal } from "../Refusal/InlineRefusal.js";

/** The code a failed matcher's line is drawn under. */
const SEARCH_FAILED_CODE = "search-failed";

/** `Search failed` with `Try again` where `matcher` failed to load; nothing otherwise. */
export function SearchFailed(props: {
  readonly matcher: FuzzyMatcherLoad;
}): React.JSX.Element | null {
  return props.matcher.state === "failed" ? (
    <InlineRefusal
      code={SEARCH_FAILED_CODE}
      detail="Search failed"
      onTryAgain={props.matcher.loadAgain}
    />
  ) : null;
}
