// What the session header draws while the session is opening.
//
// IT DRAWS A PLACEHOLDER, AND THAT IS THE WHOLE POINT. A line of text alone would make
// the header one line of prose tall while the session opens and a different height a
// moment later, so every surface below it would move down the page at the exact instant
// a person was reaching for something. The placeholder holds a fixed height, so the
// header's height is settled before the store opens and nothing under it jumps.
//
// IT IS NOT ANNOUNCED. `aria-hidden` on the placeholder: it is the shape of an answer
// and not an answer, so a screen reader is told the header is loading once, in words, by
// the absence beside it.

import { Nothing } from "../../primitives/index.js";

/** The header's opening state: a placeholder that holds its height, and the words for it. */
export function SessionHeaderSkeleton(): React.JSX.Element {
  return (
    <>
      <span className="meridian-session-header__placeholder" aria-hidden="true" />
      <Nothing kind="not-loaded" title="This session is opening." />
    </>
  );
}
