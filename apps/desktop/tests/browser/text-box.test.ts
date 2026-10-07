// The composer's draft typed past its cap, in Chromium, since happy-dom has no layout and no
// caret. The text area grows with its text and never scrolls; the box around it stops at the
// draft's row cap, scrolls, draws its bar over the text and keeps the caret in view as the
// browser reveals it. Moving the caret back to the top scrolls the box back, leaving the draft's
// last line out of view: the negative control for the in-view check.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import {
  SESSION_ID,
  TRANSCRIPT_STATES_SCENARIO_ID,
} from "#fixtures/scenarios/transcript-states.js";
import { COMPOSER_DRAFT_MAX_ROWS } from "#renderer/features/composer/bounds.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { renderAppSettled } from "../helpers/app/harness.js";

/** The marker the library puts on the element it scrolls. */
const OVERLAY_VIEWPORT_ATTRIBUTE = "data-overlayscrollbars-viewport";

/** How long a bar may take to start: the library's load plus its window's idle time. */
const OVERLAY_START_TIMEOUT_MS = 5000;

/** Lines typed into the draft, well past its cap. */
const TYPED_LINE_COUNT = COMPOSER_DRAFT_MAX_ROWS * 3;

/** Whether the draft's last line, the text area's bottom line, shows inside the box. */
function isLastLineInView(line: HTMLTextAreaElement, box: Element, lineHeightPx: number): boolean {
  const lastLineBottom = line.getBoundingClientRect().bottom;
  const boxRect = box.getBoundingClientRect();
  return lastLineBottom - lineHeightPx >= boxRect.top - 1 && lastLineBottom <= boxRect.bottom + 1;
}

/** Press keys inside `act`, so the draft store's writes are flushed into the line. */
async function press(keys: string): Promise<void> {
  await act(async () => {
    await userEvent.keyboard(keys);
  });
}

afterEach(() => {
  cleanup();
  document.location.hash = "";
});

describe("the composer's draft", () => {
  it("scrolls in its box past the cap and keeps the caret in view", async () => {
    document.location.hash = formatRoute({ kind: "session", sessionId: SESSION_ID });
    const appWindow = await renderAppSettled(TRANSCRIPT_STATES_SCENARIO_ID);
    const line = appWindow.document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Message"]',
    );
    const box = line?.parentElement;
    if (line === null || box === null || box === undefined) {
      throw new Error("the session screen drew no draft line");
    }
    await act(async () => {
      await expect
        .poll(() => box.hasAttribute(OVERLAY_VIEWPORT_ATTRIBUTE), {
          timeout: OVERLAY_START_TIMEOUT_MS,
        })
        .toBe(true);
    });

    line.focus();
    await press("line{Shift>}{Enter}{/Shift}".repeat(TYPED_LINE_COUNT - 1) + "last");
    expect(line.value.split("\n")).toHaveLength(TYPED_LINE_COUNT);

    const boxStyle = appWindow.getComputedStyle(box);
    const lineHeightPx = Number.parseFloat(boxStyle.lineHeight);
    const boxContentHeight =
      box.clientHeight -
      Number.parseFloat(boxStyle.paddingTop) -
      Number.parseFloat(boxStyle.paddingBottom);
    // The box stopped at the cap, and the text area grew past it without scrolling itself.
    expect(boxContentHeight).toBeCloseTo(COMPOSER_DRAFT_MAX_ROWS * lineHeightPx, 0);
    expect(line.scrollHeight).toBeLessThanOrEqual(line.clientHeight);
    expect(line.clientHeight).toBeGreaterThan(boxContentHeight);
    // The box scrolled to the caret on the last line, and shows no platform bar.
    expect(box.scrollTop).toBeGreaterThan(0);
    expect(isLastLineInView(line, box, lineHeightPx)).toBe(true);
    expect(boxStyle.scrollbarWidth).toBe("none");

    // Negative control: with the caret back on the first line, the last line is out of view.
    await press("{ArrowUp}".repeat(TYPED_LINE_COUNT));
    expect(line.selectionStart).toBeLessThan("line".length + 1);
    // The caret's line is revealed, not the box's padding above it.
    expect(box.scrollTop).toBeLessThan(lineHeightPx);
    expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      box.getBoundingClientRect().top - 1,
    );
    expect(isLastLineInView(line, box, lineHeightPx)).toBe(false);
  });
});
