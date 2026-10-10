// Writes the composer's height outside its draft onto the composer as
// `--meridian-composer-chrome-height`: the composer's box less the height of the text its draft box
// shows, and less the room the draft's card holds open around a draft shorter than the card's
// minimum height. That difference holds still while the draft grows, since the box and the draft
// grow by the same amount once that room is taken, so the draft's cap can be read from it with no
// measurement feeding back.

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
      // The draft's card: the region's part that holds the draft box.
      const draftCard = [...region.children].find((part) => part.contains(draftScroller));
      if (draftCard === undefined) {
        throw new Error("The composer's draft box is outside its region.");
      }
      // Fractional boxes throughout: a rounded height would move the figure as the draft grows.
      const scrollerStyle = view.getComputedStyle(draftScroller);
      const draftShownHeight =
        draftScroller.getBoundingClientRect().height -
        Number.parseFloat(scrollerStyle.paddingTop) -
        Number.parseFloat(scrollerStyle.paddingBottom);
      const chromeHeight =
        region.getBoundingClientRect().height - draftShownHeight - heldRoomOf(view, draftCard);
      region.style.setProperty("--meridian-composer-chrome-height", `${String(chromeHeight)}px`);
    });
  }, [regionRef, draftScrollerRef]);
}

/**
 * The height `card`'s minimum holds open beyond its parts: its content box less the span from its
 * first part's top margin to its last part's bottom margin, zero once its parts fill it.
 */
function heldRoomOf(view: Window, card: Element): number {
  const first = card.firstElementChild;
  const last = card.lastElementChild;
  if (first === null || last === null) {
    return 0;
  }
  const cardStyle = view.getComputedStyle(card);
  const contentHeight =
    card.getBoundingClientRect().height -
    Number.parseFloat(cardStyle.borderTopWidth) -
    Number.parseFloat(cardStyle.paddingTop) -
    Number.parseFloat(cardStyle.paddingBottom) -
    Number.parseFloat(cardStyle.borderBottomWidth);
  const partsHeight =
    last.getBoundingClientRect().bottom +
    Number.parseFloat(view.getComputedStyle(last).marginBottom) -
    (first.getBoundingClientRect().top - Number.parseFloat(view.getComputedStyle(first).marginTop));
  return Math.max(0, contentHeight - partsHeight);
}
