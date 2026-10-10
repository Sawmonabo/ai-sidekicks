// A scroll the list reads as the reader's own: the wheel turns first, so a scroll toward the head
// ends following the tail, as a person's would, where a bare `scrollTop` write would be landed back.

import { fireEvent } from "@testing-library/react";

import { changeLayout } from "../../helpers/animation-frame.js";

/** Scrolls the box to `scrollTopPx` as a reader does, and lets the list follow. */
export async function readerScrollsTo(
  scrollContainer: HTMLElement,
  scrollTopPx: number,
): Promise<void> {
  await changeLayout(() => {
    scrollContainer.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, deltaY: scrollTopPx - scrollContainer.scrollTop }),
    );
    scrollContainer.scrollTop = scrollTopPx;
    fireEvent.scroll(scrollContainer);
  });
}
