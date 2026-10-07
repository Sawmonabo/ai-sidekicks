// The composer's draft typed past its cap, in Chromium, since happy-dom has no layout and no
// caret. The text area grows with its text and never scrolls; the box around it stops at the
// smaller of the draft's row cap and a third of the session screen's height, scrolls, draws its
// bar over the text and keeps the caret in view as the browser reveals it. In a tall window the
// row cap wins and in a short one the third does, each the negative control for the other; moving
// the caret back to the top scrolls the box back, leaving the draft's last line out of view: the
// negative control for the in-view check.

import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

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

/** A window tall enough that a third of the session screen holds more than the row cap. */
const TALL_WINDOW = { width: 1440, height: 900 };

/** A window short enough that a third of the session screen holds less than the row cap. */
const SHORT_WINDOW = { width: 1440, height: 450 };

const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/** A draft typed past its cap, and what a case measures it by. */
interface LongDraft {
  readonly line: HTMLTextAreaElement;
  /** The box that scrolls, inside the frame. */
  readonly box: HTMLElement;
  /** The box's frame: its edge, the bounds a line shows within. */
  readonly frame: HTMLElement;
  readonly lineHeightPx: number;
  /** The session screen, whose height the draft's cap is measured against. */
  readonly screen: HTMLElement;
}

/** Opens the session in a window of `size`, waits for the draft's bar, and types past the cap. */
async function typeLongDraft(size: { width: number; height: number }): Promise<LongDraft> {
  await page.viewport(size.width, size.height);
  document.location.hash = formatRoute({ kind: "session", sessionId: SESSION_ID });
  const appWindow = await renderAppSettled(TRANSCRIPT_STATES_SCENARIO_ID);
  expect(appWindow.innerHeight).toBe(size.height);
  const line = appWindow.document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Message"]',
  );
  const box = line?.parentElement;
  const frame = box?.parentElement;
  const screen = appWindow.document.querySelector<HTMLElement>(".meridian-session-screen");
  if (
    line === null ||
    box === null ||
    box === undefined ||
    frame === null ||
    frame === undefined ||
    screen === null
  ) {
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

  return {
    line,
    box,
    frame,
    lineHeightPx: Number.parseFloat(styleOf(box).lineHeight),
    screen,
  };
}

/** The box's height inside its padding: what its cap bounds. */
function contentHeightOf(box: HTMLElement): number {
  const style = styleOf(box);
  return (
    box.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
  );
}

/** A third of the session screen's height. */
function thirdOf(screen: HTMLElement): number {
  return screen.getBoundingClientRect().height / 3;
}

/** The element's computed style, read in its own window: an app window is a document of its own. */
function styleOf(element: Element): CSSStyleDeclaration {
  return (element.ownerDocument.defaultView ?? window).getComputedStyle(element);
}

/**
 * Asserts the box scrolls a text area that grew past it without scrolling itself, to the caret on
 * the last line, and shows no platform bar.
 */
function expectScrolledToTheCaret(draft: LongDraft): void {
  const { line, box, frame, lineHeightPx } = draft;
  expect(line.scrollHeight).toBeLessThanOrEqual(line.clientHeight);
  expect(line.clientHeight).toBeGreaterThan(contentHeightOf(box));
  expect(box.scrollTop).toBeGreaterThan(0);
  expect(isLastLineInView(line, frame, lineHeightPx)).toBe(true);
  expect(styleOf(box).scrollbarWidth).toBe("none");
}

/** Whether the draft's last line, the text area's bottom line, shows inside the box's frame. */
function isLastLineInView(
  line: HTMLTextAreaElement,
  frame: Element,
  lineHeightPx: number,
): boolean {
  const lastLineBottom = line.getBoundingClientRect().bottom;
  const frameRect = frame.getBoundingClientRect();
  return (
    lastLineBottom - lineHeightPx >= frameRect.top - 1 && lastLineBottom <= frameRect.bottom + 1
  );
}

/** Press keys inside `act`, so the draft store's writes are flushed into the line. */
async function press(keys: string): Promise<void> {
  await act(async () => {
    await userEvent.keyboard(keys);
  });
}

beforeEach(() => {
  document.location.hash = "";
});

afterEach(async () => {
  cleanup();
  document.location.hash = "";
  await page.viewport(tierViewport.width, tierViewport.height);
});

describe("the composer's draft", () => {
  it("stops at its row cap in a tall window and keeps the caret in view", async () => {
    const draft = await typeLongDraft(TALL_WINDOW);
    const rowCapHeight = COMPOSER_DRAFT_MAX_ROWS * draft.lineHeightPx;

    // The row cap is the smaller term here, and the box stopped at it.
    expect(rowCapHeight).toBeLessThan(thirdOf(draft.screen));
    expect(contentHeightOf(draft.box)).toBeCloseTo(rowCapHeight, 0);
    expectScrolledToTheCaret(draft);

    // Negative control: with the caret back on the first line, the last line is out of view.
    const { line, box, frame, lineHeightPx } = draft;
    await press("{ArrowUp}".repeat(TYPED_LINE_COUNT));
    expect(line.selectionStart).toBeLessThan("line".length + 1);
    // The caret's line is revealed, not the box's padding above it.
    expect(box.scrollTop).toBeLessThan(lineHeightPx);
    expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      frame.getBoundingClientRect().top - 1,
    );
    expect(isLastLineInView(line, frame, lineHeightPx)).toBe(false);
  });

  it("stops at a third of the session screen in a short window", async () => {
    const draft = await typeLongDraft(SHORT_WINDOW);

    // A third of the screen is the smaller term here, and the box stopped at it.
    expect(thirdOf(draft.screen)).toBeLessThan(COMPOSER_DRAFT_MAX_ROWS * draft.lineHeightPx);
    expect(contentHeightOf(draft.box)).toBeCloseTo(thirdOf(draft.screen), 0);
    expectScrolledToTheCaret(draft);

    // The third is the screen's own, not the window's: held shorter than the window, as a title
    // bar would hold it, the screen takes the box down with it once it has measured the change.
    draft.screen.style.minBlockSize = "0";
    draft.screen.style.maxBlockSize = `${String(SHORT_WINDOW.height / 2)}px`;
    expect(thirdOf(draft.screen)).toBeCloseTo(SHORT_WINDOW.height / 6, 0);
    await expect.poll(() => contentHeightOf(draft.box)).toBeCloseTo(SHORT_WINDOW.height / 6, 0);
  });
});
