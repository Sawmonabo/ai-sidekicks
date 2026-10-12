// A scroll the list reads as the reader's own, for the renderer and browser tiers: the wheel turns
// first, then the box moves and says so, as the platform does after a wheel. A bare `scrollTop`
// write would be read as the list's own move.

import { fireEvent } from "@testing-library/react";

/**
 * Scrolls the box to `scrollTopPx` as a reader does: a wheel turned that way, then the move and
 * its scroll event. `inputAtMs`, where given, is both events' own time stamp.
 */
export function readerScrollsTo(
  scrollContainer: HTMLElement,
  scrollTopPx: number,
  inputAtMs?: number,
): void {
  const wheel = new WheelEvent("wheel", {
    bubbles: true,
    deltaY: scrollTopPx - scrollContainer.scrollTop,
  });
  const scroll = new UIEvent("scroll");
  if (inputAtMs !== undefined) {
    Object.defineProperty(wheel, "timeStamp", { value: inputAtMs });
    Object.defineProperty(scroll, "timeStamp", { value: inputAtMs });
  }
  fireEvent(scrollContainer, wheel);
  scrollContainer.scrollTop = scrollTopPx;
  fireEvent(scrollContainer, scroll);
}
