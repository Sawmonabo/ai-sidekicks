// What the session header draws while the session is opening.
//
// IT DRAWS A PLACEHOLDER, AND THAT IS THE WHOLE POINT. The loading arm used to be a
// single line of text, so the header was one line of prose tall while the session opened
// and one line of readings tall a moment later — every surface below it moved down the
// page at the exact instant a person was reaching for something. The placeholder is the
// same height as the readings it stands in for, so the header's height is settled before
// the first one arrives and nothing under it jumps.
//
// IT IS NOT ANNOUNCED. `aria-hidden` on the placeholder: it is the shape of an answer
// and not an answer, so a screen reader is told the header is loading once, in words, by
// the absence beside it.

import { Nothing } from "../../primitives/index.js";

export function SessionHeaderSkeleton(): React.JSX.Element {
  return (
    <>
      <span className="meridian-session-header__placeholder" aria-hidden="true" />
      <Nothing kind="not-loaded" title="This session is opening." />
    </>
  );
}
