// A long diff opened whole in the flow, in Chromium. Show all mounts the rows a step at a time and
// holds no room for rows not mounted yet, so End pressed right after Show all, a jump the
// compositor scrolls, never paints a part of the block with no rows: every frame the browser draws
// meanwhile is read back from a trace and checked. And a reader past the rows the press drew stays
// where they were as the steps land above them.

import { cleanup, fireEvent } from "@testing-library/react";
import { cdp } from "vitest/browser";
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
import { RealMouse } from "./real-mouse.js";

/** The flow's box, in CSS pixels. */
const FLOW_HEIGHT_PX = 600;
const FLOW_WIDTH_PX = 560;

/** The long file's lines: enough that the steps are still landing while the scroll runs. */
const LONG_LINE_COUNT = 5000;

/** Frames a fill of the diffs here may take before a case gives up on it. */
const FILL_FRAME_LIMIT = 600;

/** How far a picture's color may sit from the block's ground and still be it, per channel (JPEG). */
const GROUND_TOLERANCE = 4;

/** How long the trace runs on after the block fills, so the last frames' pictures arrive. */
const TRACE_SETTLE_MS = 500;

/** The short files after the long one in the reader's case. */
const SHORT_FILE_COUNT = 8;

/** How far a row may land from where the reader saw it and still be the same place. */
const HELD_TOLERANCE_PX = 1;

/** The trace's marks around the driven scroll, as performance marks. */
const DRIVE_MARK = "show-all-scroll-driven";
const FILLED_MARK = "show-all-block-filled";

/** The trace's events for the copy of a frame the page asked for, and its picture. */
const FRAME_COPIED = "Surface::RequestCopyOfOutput";
const FRAME_PICTURED = "Screenshot";

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(() => {
  cleanup();
});

describe("browser — Show all on a long diff", () => {
  it("never paints the block without its rows when End scrolls right after the press", async () => {
    const { flow, block } = drawDiffCard(diffOf([longPatch(LONG_LINE_COUNT)]), {
      heightPx: FLOW_HEIGHT_PX,
      widthPx: FLOW_WIDTH_PX,
    });
    const mouse = await RealMouse.calibrated(document);
    fireEvent.click(showAllOf(block));

    // End goes to the focused rows' scroller, the flow, which the compositor scrolls.
    const pictures = await framesDrawnUntilFilled(block, async () => {
      for (const type of ["rawKeyDown", "keyUp"] as const) {
        await cdp().send("Input.dispatchKeyEvent", {
          type,
          key: "End",
          code: "End",
          windowsVirtualKeyCode: 35,
        });
      }
    });

    expect(flow.scrollTop).toBeGreaterThan(0);
    expectEveryFrameDrawn(pictures, mouse, flow, block);
  });

  it("keeps a reader past the rows the press drew still as the steps land above them", async () => {
    const scrollController = new ScrollController({ clock: new ManualClock() });
    // Short files after the long one, so the flow scrolls past every row the press draws.
    const shortFiles = Array.from({ length: SHORT_FILE_COUNT }, (_unused, ordinal) =>
      filePatch(`short-${String(ordinal)}.ts`, "@@ -1,3 +1,3 @@", [" a", "-b", "+B", " c"]),
    );
    const {
      flow,
      card,
      block: longBlock,
    } = drawDiffCard(diffOf([longPatch(1200), ...shortFiles]), {
      heightPx: FLOW_HEIGHT_PX,
      widthPx: FLOW_WIDTH_PX,
      viewport: suiteWindowViewport(scrollController, {
        subscribe: () => () => undefined,
        read: () => undefined,
      }),
    });
    scrollController.attach(flow);

    fireEvent.click(showAllOf(longBlock));
    // At once just past the long file's block, below every row the press mounted.
    flow.scrollTop +=
      longBlock.getBoundingClientRect().bottom - flow.getBoundingClientRect().top + 20;
    await nextFrame();
    expect(longBlock.getBoundingClientRect().bottom).toBeLessThan(flow.getBoundingClientRect().top);
    const reference = firstRowOnScreen(card, flow);
    const readerTopPx = reference.getBoundingClientRect().top;
    const heightAtStartPx = longBlock.getBoundingClientRect().height;

    // Where the reader's row stands each time the block grows, read once the frame's resize
    // observations are answered, the block's own first, so as the frame paints it.
    const movesPx: number[] = [];
    const growth = new ResizeObserver(() => {
      movesPx.push(reference.getBoundingClientRect().top - readerTopPx);
    });
    growth.observe(longBlock);
    for (let frame = 1; !isFilled(longBlock, 1200); frame += 1) {
      if (frame > FILL_FRAME_LIMIT) {
        throw new Error(`the block was not filled within ${String(FILL_FRAME_LIMIT)} frames`);
      }
      await nextFrame();
    }
    await letObserversAnswer();
    growth.disconnect();
    // The first answer is the block as the reader found it; the rest are its steps landing.
    expect(movesPx.length).toBeGreaterThan(1);
    for (const [frame, movedPx] of movesPx.entries()) {
      expect(Math.abs(movedPx), `moved ${String(movedPx)} at growth ${String(frame)}`).toBeLessThan(
        HELD_TOLERANCE_PX,
      );
    }
    // The steps did land above the reader while they read.
    expect(longBlock.getBoundingClientRect().height - heightAtStartPx).toBeGreaterThan(
      FLOW_HEIGHT_PX,
    );
  });
});

/**
 * A picture of the top page for every frame the browser drew from the driven scroll until the
 * block had every row mounted. A trace's screenshot category copies each frame of the page the
 * display draws out as a picture right after it; a copy in that span with no picture of its own
 * throws, so a frame left unchecked can never read as a pass.
 */
async function framesDrawnUntilFilled(
  block: HTMLElement,
  drive: () => Promise<void>,
): Promise<readonly ImageBitmap[]> {
  const session = cdp();
  const events: TraceEvent[] = [];
  const collect = (batch: {
    readonly value: readonly Readonly<Record<string, unknown>>[];
  }): void => {
    events.push(...batch.value.map(traceEventOf));
  };
  let endTrace: (() => void) | undefined;
  const traceEnded = new Promise<void>((resolve) => {
    endTrace = resolve;
  });
  const complete = (): void => {
    endTrace?.();
  };
  session.on("Tracing.dataCollected", collect);
  session.on("Tracing.tracingComplete", complete);
  try {
    await session.send("Tracing.start", {
      traceConfig: {
        includedCategories: ["disabled-by-default-devtools.screenshot", "viz", "blink.user_timing"],
      },
      transferMode: "ReportEvents",
    });
    // The first copies after the trace starts can come in a pair with one picture between them.
    await nextFrame();
    await nextFrame();
    performance.mark(DRIVE_MARK);
    await drive();
    for (let frame = 0; !isFilled(block, LONG_LINE_COUNT); frame += 1) {
      if (frame > FILL_FRAME_LIMIT) {
        throw new Error(`the block was not filled within ${String(FILL_FRAME_LIMIT)} frames`);
      }
      await nextFrame();
    }
    performance.mark(FILLED_MARK);
    // A picture is copied out after its frame is drawn, so the trace runs on, asking for no frame,
    // until the last frame's picture is in.
    await new Promise((resolve) => {
      setTimeout(resolve, TRACE_SETTLE_MS);
    });
    await session.send("Tracing.end");
    await traceEnded;
  } finally {
    session.off("Tracing.dataCollected", collect);
    session.off("Tracing.tracingComplete", complete);
  }
  return Promise.all(
    picturedFrames(events).map(async (snapshot) =>
      createImageBitmap(await (await fetch(`data:image/jpeg;base64,${snapshot}`)).blob()),
    ),
  );
}

/** One trace event, as far as the cases read it: a picture's event carries its JPEG. */
interface TraceEvent {
  readonly name: string;
  readonly ts: number;
  readonly snapshot?: string;
}

function traceEventOf(event: Readonly<Record<string, unknown>>): TraceEvent {
  const { name, ts, args } = event;
  if (typeof name !== "string" || typeof ts !== "number") {
    throw new Error("the trace sent an event with no name or time");
  }
  const snapshot =
    typeof args === "object" && args !== null && "snapshot" in args ? args.snapshot : undefined;
  return typeof snapshot === "string" ? { name, ts, snapshot } : { name, ts };
}

/**
 * The picture of each frame the page asked to have copied between the two marks, in order. The
 * page asks for a copy of each frame of its own the display draws, and the picture comes back
 * before the next copy is asked for; the display's own draws are not read, since it also draws
 * other pages' frames. Throws for a copy with no picture of its own.
 */
function picturedFrames(events: readonly TraceEvent[]): readonly string[] {
  const driveTs = events.find((event) => event.name === DRIVE_MARK)?.ts;
  const filledTs = events.find((event) => event.name === FILLED_MARK)?.ts;
  if (driveTs === undefined || filledTs === undefined) {
    throw new Error("the trace holds no marks around the driven scroll");
  }
  const timeline = events
    .filter((event) => event.name === FRAME_COPIED || event.name === FRAME_PICTURED)
    .toSorted((left, right) => left.ts - right.ts);
  const snapshots: string[] = [];
  let unpicturedCopyTs: number | undefined;
  for (const event of timeline) {
    if (event.name === FRAME_PICTURED) {
      if (unpicturedCopyTs !== undefined) {
        if (event.snapshot === undefined) {
          throw new Error(
            `the picture of a frame copied at ${String(unpicturedCopyTs)} µs is empty`,
          );
        }
        snapshots.push(event.snapshot);
        unpicturedCopyTs = undefined;
      }
      continue;
    }
    if (unpicturedCopyTs !== undefined) {
      throw new Error(`a frame copied at ${String(unpicturedCopyTs)} µs came back as no picture`);
    }
    unpicturedCopyTs = event.ts > driveTs && event.ts < filledTs ? event.ts : undefined;
  }
  if (unpicturedCopyTs !== undefined) {
    throw new Error(`a frame copied at ${String(unpicturedCopyTs)} µs came back as no picture`);
  }
  if (snapshots.length === 0) {
    throw new Error("no frame was pictured while the block filled");
  }
  return snapshots;
}

/**
 * Every frame drawn shows rows wherever the flow shows the block: down a line of pixels past the
 * rows' text, the block's bare ground never stands taller than its footer, the one part of the
 * block with no rows on it. Room held for rows not mounted reads as that bare ground.
 */
function expectEveryFrameDrawn(
  pictures: readonly ImageBitmap[],
  mouse: RealMouse,
  flow: HTMLElement,
  block: HTMLElement,
): void {
  expect(pictures.length).toBeGreaterThan(0);
  const footer = block.querySelector<HTMLElement>(".meridian-diff-block__footer");
  if (footer === null) {
    throw new Error("the block drew no footer");
  }
  const box = flow.getBoundingClientRect();
  const top = mouse.toPage({ x: box.right - 60, y: box.top + 1 });
  const bottom = mouse.toPage({ x: box.right - 60, y: box.bottom - 1 });
  const footerPagePx =
    mouse.toPage({ x: 0, y: footer.offsetHeight }).y - mouse.toPage({ x: 0, y: 0 }).y;
  const pageWidthPx = window.top?.innerWidth ?? window.innerWidth;
  const ground = resolvedRgb("var(--meridian-surface-sunken)");

  for (const [index, picture] of pictures.entries()) {
    const pixelsPerPagePx = picture.width / pageWidthPx;
    const column = pixelColumn(picture, Math.round(top.x * pixelsPerPagePx));
    let runPx = 0;
    let longestRunPx = 0;
    for (
      let row = Math.ceil(top.y * pixelsPerPagePx);
      row <= bottom.y * pixelsPerPagePx;
      row += 1
    ) {
      const isGround = ground.every(
        (channel, at) => Math.abs((column[row * 4 + at] ?? 0) - channel) <= GROUND_TOLERANCE,
      );
      runPx = isGround ? runPx + 1 / pixelsPerPagePx : 0;
      longestRunPx = Math.max(longestRunPx, runPx);
    }
    expect(longestRunPx, `frame ${String(index)} shows the block with no rows`).toBeLessThanOrEqual(
      footerPagePx + 2,
    );
  }
}

/** A CSS color as the screen draws it, red, green and blue. */
function resolvedRgb(color: string): readonly number[] {
  const probe = document.createElement("span");
  probe.style.color = color;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("no 2D context to resolve a color with");
  }
  context.fillStyle = resolved;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
}

/** One column of a picture's pixels, top to bottom, four channels each. */
function pixelColumn(picture: ImageBitmap, x: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(picture.width, picture.height);
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("no 2D context to read a picture with");
  }
  context.drawImage(picture, 0, 0);
  return context.getImageData(x, 0, 1, picture.height).data;
}

function isFilled(block: HTMLElement, lineCount: number): boolean {
  return block.querySelectorAll(".meridian-diff__row--line").length === lineCount;
}

/** The first of the card's rows wholly on the flow's screen. */
function firstRowOnScreen(card: HTMLElement, flow: HTMLElement): HTMLElement {
  const screen = flow.getBoundingClientRect();
  const row = [...card.querySelectorAll<HTMLElement>('[role="row"]')].find((candidate) => {
    const box = candidate.getBoundingClientRect();
    return box.top >= screen.top && box.bottom <= screen.bottom;
  });
  if (row === undefined) {
    throw new Error("no row stands on the flow's screen");
  }
  return row;
}

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

/** One file of `lineCount` added lines, each short enough that none wraps. */
function longPatch(lineCount: number): string {
  const body: string[] = [];
  for (let ordinal = 0; ordinal < lineCount; ordinal += 1) {
    body.push(`+const value${String(ordinal)} = compute(${String(ordinal)});`);
  }
  return filePatch("module.ts", `@@ -0,0 +1,${String(lineCount)} @@`, body);
}
