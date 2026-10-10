// The history line above the first row, in the engine that lays it out. It sits in the flow, so
// every change in its height moves every row below it; a DOM shim lays nothing out, so a row
// there stays put whether or not the viewport holds it.
//
// The feed is mounted in a box narrow enough that the failed read's line wraps onto a second line,
// so the line grows when a read fails, shrinks when it is asked again, and leaves once the stretch
// it read reaches the session's first message. A reader past the line keeps their row; a reader at
// the top sees the line grow in place, its head still in view.

import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { changeLayout } from "../../helpers/animation-frame.js";
import {
  EARLIER_HISTORY_BOX_HEIGHT_PX,
  EARLIER_HISTORY_ROW_HEIGHT_PX,
  mountEarlierHistoryFeed,
} from "../../helpers/transcript/earlier-history-feed.js";

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

/** The history line's box, which a case measures to the fraction a layout gives it. */
function headOf(scrollContainer: HTMLElement): HTMLElement {
  const head = scrollContainer.querySelector<HTMLElement>(".meridian-transcript-viewport__head");
  if (head === null) {
    throw new Error("the feed drew no history line");
  }
  return head;
}

/** The height the history line takes above the rows, unrounded. */
function headHeightPx(scrollContainer: HTMLElement): number {
  return headOf(scrollContainer).getBoundingClientRect().height;
}

/** The press on the failed line's `Try again`. */
function pressTryAgain(container: HTMLElement): Promise<void> {
  const tryAgain = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Try again",
  );
  return changeLayout(() => {
    tryAgain?.click();
  });
}

/** A stylesheet the case adds for itself, removed after it. */
let caseSheet: HTMLStyleElement | undefined;

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(() => {
  caseSheet?.remove();
  caseSheet = undefined;
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
    await pressTryAgain(container);
    expect(headHeightPx(scrollContainer)).toBe(oneLineHeightPx);
    expectRowHeld();

    // The stretch lands above the reader and reaches the first message, so the line leaves.
    await landRead();
    expect(sessionStore.snapshot().transcript[0]?.sequence).toBe(0);
    expect(container.querySelector(".meridian-transcript-viewport__load-earlier")).toBeNull();
    expectRowHeld();
  });

  it("keeps the row in place through changes of a fractional height", async () => {
    // A line whose height is no whole pixel moves the rows by a fraction the offset cannot take
    // in one write; what it leaves over is moved with the next change. A half pixel is the worst
    // case: the platform rounds it the same way growing and shrinking, so without the carry each
    // failure and retry would leave the row a pixel further from where it stood.
    caseSheet = document.createElement("style");
    caseSheet.textContent = ".meridian-transcript-viewport__head { line-height: 16.5px; }";
    document.head.append(caseSheet);
    const { container, scrollContainer, log, landRead } = await mountEarlierHistoryFeed();
    await changeLayout(() => {
      scrollContainer.scrollTop = READING_AT_PX;
      fireEvent.scroll(scrollContainer);
    });
    const underReader = rowUnderReader(scrollContainer);
    const oneLineHeightPx = headHeightPx(scrollContainer);
    expect(Number.isInteger(oneLineHeightPx)).toBe(false);
    await changeLayout(() => {
      container
        .querySelector<HTMLButtonElement>(".meridian-transcript-viewport__load-earlier")
        ?.click();
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      log.refuseNextRead();
      await landRead();
      await pressTryAgain(container);
    }

    expect(headHeightPx(scrollContainer)).toBe(oneLineHeightPx);
    expect(
      Math.abs(offsetOfRow(scrollContainer, underReader.id) - underReader.offsetPx),
    ).toBeLessThanOrEqual(HELD_TOLERANCE_PX);
  });

  it("lets the rows flow below the line at the top of the log, its head in view", async () => {
    const { container, scrollContainer, log, landRead } = await mountEarlierHistoryFeed();
    await changeLayout(() => {
      scrollContainer.scrollTop = 0;
      fireEvent.scroll(scrollContainer);
    });
    // At the top the reader reads the stretch on its own; the line reads `Loading…`.
    expect(container.textContent).toContain("Loading…");
    const firstRowId =
      scrollContainer.querySelector<HTMLElement>("[data-row-id]")?.dataset["rowId"] ?? "";
    const firstRowOffsetPx = offsetOfRow(scrollContainer, firstRowId);
    const oneLineHeightPx = headHeightPx(scrollContainer);

    log.refuseNextRead();
    await landRead();

    const grownPx = headHeightPx(scrollContainer) - oneLineHeightPx;
    expect(grownPx).toBeGreaterThan(0);
    expect(scrollContainer.scrollTop).toBe(0);
    expect(headOf(scrollContainer).getBoundingClientRect().top).toBeGreaterThanOrEqual(
      scrollContainer.getBoundingClientRect().top,
    );
    expect(
      Math.abs(offsetOfRow(scrollContainer, firstRowId) - (firstRowOffsetPx + grownPx)),
    ).toBeLessThanOrEqual(HELD_TOLERANCE_PX);
  });
});
