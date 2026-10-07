// The composer's draft typed past its cap, in Chromium, since happy-dom has no layout and no
// caret. The text area grows with its text and never scrolls; the box around it stops at the
// smaller of the draft's row cap and a third of the conversation's visible height, the pane row
// the draft's own growth takes from, scrolls, draws its bar over the text and keeps the caret in
// view as the browser reveals it. In a tall window the row cap wins and in a window at the height
// floor the third does, each the negative control for the other; moving the caret back to the top
// scrolls the box back, leaving the draft's last line out of view: the negative control for the
// in-view check.

import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  SESSION_ID,
  TRANSCRIPT_STATES_SCENARIO_ID,
} from "#fixtures/scenarios/transcript-states.js";
import { COMPOSER_DRAFT_MAX_ROWS } from "#renderer/features/composer/bounds.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { WINDOW_HEIGHT_FLOOR_REM } from "#renderer/styles/palette.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { renderAppSettled } from "../helpers/app/harness.js";

/** The marker the library puts on the element it scrolls. */
const OVERLAY_VIEWPORT_ATTRIBUTE = "data-overlayscrollbars-viewport";

/** How long a bar may take to start: the library's load plus its window's idle time. */
const OVERLAY_START_TIMEOUT_MS = 5000;

/** Lines typed into the draft, well past its cap. */
const TYPED_LINE_COUNT = COMPOSER_DRAFT_MAX_ROWS * 3;

/** A window tall enough that a third of the conversation holds more than the row cap. */
const TALL_WINDOW = { width: 1440, height: 900 };

/**
 * A window at the height floor, the shortest a window can be at the default text size, where a
 * third of the conversation holds less than the row cap.
 */
const FLOOR_WINDOW = {
  width: 1440,
  height: WINDOW_HEIGHT_FLOOR_REM * DEFAULT_APPEARANCE_RECORD.textSize,
};

const tierViewport = { width: window.innerWidth, height: window.innerHeight };

/** A draft typed past its cap, and what a case measures it by. */
interface LongDraft {
  readonly line: HTMLTextAreaElement;
  /** The box that scrolls, inside the frame. */
  readonly box: HTMLElement;
  /** The box's frame: its edge, the bounds a line shows within. */
  readonly frame: HTMLElement;
  readonly lineHeightPx: number;
  /** The session screen, whose flow the conversation and the composer share. */
  readonly screen: HTMLElement;
  /** The conversation's pane row, whose height the draft's cap is a third of. */
  readonly paneRow: HTMLElement;
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
  const paneRow = screen?.querySelector<HTMLElement>(":scope > .meridian-pane-layout");
  if (
    line === null ||
    box === null ||
    box === undefined ||
    frame === null ||
    frame === undefined ||
    screen === null ||
    paneRow === null ||
    paneRow === undefined
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
    paneRow,
  };
}

/** The box's height inside its padding: what its cap bounds. */
function contentHeightOf(box: HTMLElement): number {
  const style = styleOf(box);
  return (
    box.clientHeight - Number.parseFloat(style.paddingTop) - Number.parseFloat(style.paddingBottom)
  );
}

/** A third of the conversation's visible height: its pane row's. */
function thirdOfConversation(draft: LongDraft): number {
  return draft.paneRow.getBoundingClientRect().height / 3;
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
    expect(rowCapHeight).toBeLessThan(thirdOfConversation(draft));
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

  it("stops at a third of the conversation in a window at the height floor", async () => {
    const draft = await typeLongDraft(FLOOR_WINDOW);

    // A third of the conversation is the smaller term here, and the box stopped at it.
    expect(thirdOfConversation(draft)).toBeLessThan(COMPOSER_DRAFT_MAX_ROWS * draft.lineHeightPx);
    expect(contentHeightOf(draft.box)).toBeCloseTo(thirdOfConversation(draft), 0);
    expectScrolledToTheCaret(draft);

    // The third is the conversation's own, not the window's: with the screen held shorter than
    // the window, as a title bar would hold it, the box comes down with the conversation once the
    // screen has measured the change, and stays a third of it.
    const conversationBefore = draft.paneRow.getBoundingClientRect().height;
    draft.screen.style.minBlockSize = "0";
    draft.screen.style.maxBlockSize = `${String(FLOOR_WINDOW.height * 0.75)}px`;
    await expect
      .poll(() => contentHeightOf(draft.box))
      .toBeLessThan(conversationBefore / 3 - draft.lineHeightPx);
    expect(contentHeightOf(draft.box)).toBeCloseTo(thirdOfConversation(draft), 0);
  });
});
