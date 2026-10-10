// The history line above the first row, in the engine that lays it out. It sits in the flow, so
// every change in its height moves every row below it; a DOM shim lays nothing out, so a row
// there stays put whether or not the viewport holds it.
//
// The feed is mounted in a box narrow enough that the failed read's line wraps onto a second line,
// so the line grows when a read fails, shrinks when it is asked again, and leaves once the stretch
// it read reaches the session's first message.

import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { changeLayout } from "../../helpers/animation-frame.js";
import {
  EARLIER_HISTORY_BOX_HEIGHT_PX,
  EARLIER_HISTORY_ROW_HEIGHT_PX,
  mountEarlierHistoryFeed,
} from "../../helpers/earlier-history-feed.js";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
// The viewport's stylesheet and the clickable word's, imported for their side effect: this tier
// measures the line they lay out.
import "#renderer/features/transcript/viewport/components/transcript-viewport.css";
import "#renderer/styles/action-buttons.css";

/** Where the reader stands: past the distance from the top that reads a stretch on its own. */
const READING_AT_PX = 2 * EARLIER_HISTORY_BOX_HEIGHT_PX + 2 * EARLIER_HISTORY_ROW_HEIGHT_PX;
/** How far the reader's row may land from where it stood and still be the same place. */
const HELD_TOLERANCE_PX = 1;

/** The row whose box holds the top of the scroll container, and how far below the top it starts. */
function rowUnderReader(scrollContainer: HTMLElement): { id: string; offsetPx: number } {
  const topPx = scrollContainer.getBoundingClientRect().top;
  for (const row of scrollContainer.querySelectorAll<HTMLElement>("[data-row-id]")) {
    const box = row.getBoundingClientRect();
    if (box.top <= topPx && box.bottom > topPx) {
      return { id: row.dataset["rowId"] ?? "", offsetPx: box.top - topPx };
    }
  }
  throw new Error("no row holds the top of the scroll container");
}

/** Where the row `id` starts below the top of the scroll container now. */
function offsetOfRow(scrollContainer: HTMLElement, id: string): number {
  const row = scrollContainer.querySelector(`[data-row-id="${id}"]`);
  if (row === null) {
    throw new Error(`row ${id} is no longer drawn`);
  }
  return row.getBoundingClientRect().top - scrollContainer.getBoundingClientRect().top;
}

/** The height the history line takes above the rows. */
function headHeightPx(scrollContainer: HTMLElement): number {
  return scrollContainer.querySelector(".meridian-transcript-viewport__head")?.clientHeight ?? 0;
}

beforeEach(() => {
  installMeridianTokens(document);
});

describe("browser — the history line holds the reader's row as its height changes", () => {
  it("keeps the row in place as the line fails, is asked again and leaves with the stretch", async () => {
    const { container, scrollContainer, sessionStore, log, landRead } =
      await mountEarlierHistoryFeed();
    await changeLayout(() => {
      scrollContainer.scrollTop = READING_AT_PX;
      fireEvent.scroll(scrollContainer);
    });
    const underReader = rowUnderReader(scrollContainer);
    const expectRowHeld = (): void => {
      expect(
        Math.abs(offsetOfRow(scrollContainer, underReader.id) - underReader.offsetPx),
      ).toBeLessThanOrEqual(HELD_TOLERANCE_PX);
    };
    const oneLineHeightPx = headHeightPx(scrollContainer);
    expect(oneLineHeightPx).toBeGreaterThan(0);

    // Pressed, the line reads `Loading…` in its own place.
    const loadEarlier = container.querySelector<HTMLButtonElement>(
      ".meridian-transcript-viewport__load-earlier",
    );
    await changeLayout(() => {
      loadEarlier?.click();
    });
    expect(loadEarlier?.textContent).toBe("Loading…");
    expectRowHeld();

    // The read fails: the failure's words wrap, so the line grows above the reader.
    log.refuseNextRead();
    await landRead();
    expect(container.textContent).toContain("Couldn't load earlier messages");
    expect(headHeightPx(scrollContainer)).toBeGreaterThan(oneLineHeightPx);
    expectRowHeld();

    // `Try again` brings the one-line `Loading…` back, so the line shrinks.
    const tryAgain = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    await changeLayout(() => {
      tryAgain?.click();
    });
    expect(headHeightPx(scrollContainer)).toBe(oneLineHeightPx);
    expectRowHeld();

    // The stretch lands above the reader and reaches the first message, so the line leaves.
    await landRead();
    expect(sessionStore.snapshot().transcript[0]?.sequence).toBe(0);
    expect(container.querySelector(".meridian-transcript-viewport__load-earlier")).toBeNull();
    expectRowHeld();
  });
});
