// Writes the composer's height outside its draft onto the composer as
// `--meridian-composer-chrome-height`: the composer's box less the height of the text its draft box
// shows. That difference holds still while the draft grows, since the box and the draft grow by
// the same amount, so the draft's cap can be read from it with no measurement feeding back.

import { useEffect } from "react";

import { observeElementResize } from "#renderer/lib/element-resize.js";

/**
 * Keep `--meridian-composer-chrome-height` on `regionRef`'s element current on every resize of
 * it. Both refs must be attached by the first effect; a composer without a draft box throws.
 */
export function useCarryComposerChromeHeight(
  regionRef: React.RefObject<HTMLElement | null>,
  draftScrollerRef: React.RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const region = regionRef.current;
    const draftScroller = draftScrollerRef.current;
    if (region === null || draftScroller === null) {
      throw new Error("The composer mounted without its region or its draft box.");
    }
    // The composer draws in its window's own document, whose styles its own window computes.
    const view = draftScroller.ownerDocument.defaultView;
    if (view === null) {
      throw new Error("The composer's draft box is in a document with no window.");
    }
    return observeElementResize(region, () => {
      // Fractional boxes throughout: a rounded height would move the figure as the draft grows.
      const scrollerStyle = view.getComputedStyle(draftScroller);
      const draftShownHeight =
        draftScroller.getBoundingClientRect().height -
        Number.parseFloat(scrollerStyle.paddingTop) -
        Number.parseFloat(scrollerStyle.paddingBottom);
      region.style.setProperty(
        "--meridian-composer-chrome-height",
        `${String(region.getBoundingClientRect().height - draftShownHeight)}px`,
      );
    });
  }, [regionRef, draftScrollerRef]);
}
