// A long diff opened whole in the flow, in Chromium, read frame by frame. Show all mounts the
// rows a step at a time, and a person who jumps past the steps already mounted, or back to steps
// laid out long ago, never sees the room held for rows instead of the rows; and a reader who
// scrolls back up into rows never laid out stays where they were as those rows take their heights.

import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  diffOf,
  drawDiffCard,
  filePatch,
} from "#renderer/features/repos/diff/components/InlineDiffCard.test-support.js";
import { suiteWindowViewport } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { ManualClock } from "#renderer/lib/clock.js";
import { ScrollController } from "#renderer/lib/scroll/chokepoint.js";
import { letObserversAnswer, nextFrame } from "../helpers/animation-frame.js";

/** The flow's box, in CSS pixels. */
const FLOW_HEIGHT_PX = 600;
const FLOW_WIDTH_PX = 560;

/** Frames a fill of the diffs here may take before a case gives up on it. */
const FILL_FRAME_LIMIT = 600;

/** How far one step of a reader's scroll back up moves, in CSS pixels. */
const READER_SCROLL_PX = 240;

/** How far a row may land from where the scroll put it and still be the same place. */
const HELD_TOLERANCE_PX = 1;

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(() => {
  cleanup();
});

describe("browser — Show all on a long diff", () => {
  it("never paints the room held for rows where the flow shows them", async () => {
    const { flow, block } = drawDiffCard(diffOf([longPatch(2000, () => false)]), {
      heightPx: FLOW_HEIGHT_PX,
      widthPx: FLOW_WIDTH_PX,
    });

    // Show all draws the screen it opens on in its first frame.
    fireEvent.click(showAllOf(block));
    await nextFrame();
    expectScreenDrawn(flow, block);

    // A jump to the block's end at once, as the End key or a drag of the scrollbar to its foot
    // makes one, long before the steps reach it.
    flow.scrollTop = flow.scrollHeight;
    const filledAfterFrames = await everyFrameUntil(
      () => block.querySelector(".meridian-diff-block__step--held") === null,
      () => {
        expectScreenDrawn(flow, block);
      },
    );
    expect(filledAfterFrames).toBeGreaterThan(1);

    // Every step mounted: back to the top, then at once to the end again, onto steps laid out
    // long before and skipped since.
    flow.scrollTop = 0;
    await letObserversAnswer();
    flow.scrollTop = flow.scrollHeight;
    for (let frame = 0; frame < 4; frame += 1) {
      await nextFrame();
      expectScreenDrawn(flow, block);
    }
  });

  it("keeps the reader still as rows above them are laid out for the first time", async () => {
    const scrollController = new ScrollController({ clock: new ManualClock() });
    // A third of the lines wrap, so a step laid out takes more room than it was held at.
    const { flow, block } = drawDiffCard(
      diffOf([longPatch(1200, (ordinal) => ordinal % 3 === 0)]),
      {
        heightPx: FLOW_HEIGHT_PX,
        widthPx: FLOW_WIDTH_PX,
        viewport: suiteWindowViewport(scrollController, {
          subscribe: () => () => undefined,
          read: () => undefined,
        }),
      },
    );
    scrollController.attach(flow);

    fireEvent.click(showAllOf(block));
    flow.scrollTop = flow.scrollHeight;
    await everyFrameUntil(
      () => block.querySelector(".meridian-diff-block__step--held") === null,
      () => undefined,
    );
    await letObserversAnswer();

    // Up the block a scroll at a time, into steps never laid out: each scroll moves the row the
    // reader was looking at down by exactly the scroll, however much the rows above it grew.
    let grownAbovePx = 0;
    for (let scroll = 0; scroll < 12; scroll += 1) {
      const reference = rowAtMiddleOf(flow);
      const topBeforePx = reference.getBoundingClientRect().top;
      const blockHeightBeforePx = block.getBoundingClientRect().height;
      flow.scrollTop -= READER_SCROLL_PX;
      await letObserversAnswer();
      grownAbovePx += block.getBoundingClientRect().height - blockHeightBeforePx;
      const movedPx = reference.getBoundingClientRect().top - topBeforePx;
      expect(Math.abs(movedPx - READER_SCROLL_PX), `moved ${String(movedPx)}`).toBeLessThanOrEqual(
        HELD_TOLERANCE_PX,
      );
    }
    // The scrolls did reach rows that took more room than they were held at.
    expect(grownAbovePx).toBeGreaterThan(READER_SCROLL_PX);
  });
});

/** The block's `Show all` control. */
function showAllOf(block: HTMLElement): HTMLButtonElement {
  const showAll = [...block.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Show all",
  );
  if (showAll === undefined) {
    throw new Error("the block drew no Show all");
  }
  return showAll;
}

/**
 * Check each frame before it paints, in its animation callback, until `isDone` holds; answers how
 * many frames that took. A scroll's own handler runs before the animation callbacks of its frame,
 * so what the check reads there is what the frame paints.
 */
async function everyFrameUntil(isDone: () => boolean, check: () => void): Promise<number> {
  for (let frame = 1; frame <= FILL_FRAME_LIMIT; frame += 1) {
    await nextFrame();
    check();
    if (isDone()) {
      return frame;
    }
  }
  throw new Error(`the block was not filled within ${String(FILL_FRAME_LIMIT)} frames`);
}

/**
 * Every step of the block the flow shows holds its rows, and its rows are laid out rather than
 * skipped, so no part of the screen is the block's bare ground.
 */
function expectScreenDrawn(flow: HTMLElement, block: HTMLElement): void {
  const screen = flow.getBoundingClientRect();
  const shown = [...block.querySelectorAll<HTMLElement>("[data-diff-flow-step]")].filter((step) => {
    const box = step.getBoundingClientRect();
    return box.bottom > screen.top && box.top < screen.bottom;
  });
  expect(shown.length).toBeGreaterThan(0);
  for (const step of shown) {
    expect(step.classList, "a held step is on the screen").not.toContain(
      "meridian-diff-block__step--held",
    );
    for (const row of [step.firstElementChild, step.lastElementChild]) {
      expect(row?.checkVisibility({ contentVisibilityAuto: true }), "a skipped step").toBe(true);
    }
  }
}

/** The row at the middle of the flow's box. */
function rowAtMiddleOf(flow: HTMLElement): HTMLElement {
  const screen = flow.getBoundingClientRect();
  const row = document
    .elementFromPoint(screen.left + screen.width / 2, screen.top + screen.height / 2)
    ?.closest<HTMLElement>('[role="row"]');
  if (row === null || row === undefined) {
    throw new Error("no row stands at the middle of the flow");
  }
  return row;
}

/** One file of `lineCount` added lines, those `isLong` names long enough to wrap. */
function longPatch(lineCount: number, isLong: (ordinal: number) => boolean): string {
  const body: string[] = [];
  for (let ordinal = 0; ordinal < lineCount; ordinal += 1) {
    body.push(
      isLong(ordinal)
        ? `+const wrapped${String(ordinal)} = [${"value, ".repeat(30)}];`
        : `+const value${String(ordinal)} = compute(${String(ordinal)});`,
    );
  }
  return filePatch("module.ts", `@@ -0,0 +1,${String(lineCount)} @@`, body);
}
