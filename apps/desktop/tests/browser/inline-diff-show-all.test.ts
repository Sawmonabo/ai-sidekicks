// A long diff opened whole in a flow outside a transcript viewport, in Chromium. Show all mounts
// the rows a step at a time and holds no room for rows not mounted yet, so End pressed right after
// Show all, a jump the compositor scrolls, never paints a part of the block with no rows: every
// frame the browser captures meanwhile is read back from a trace and checked.

import { cleanup, fireEvent } from "@testing-library/react";
import { cdp } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installMeridianTokens } from "#renderer/app/token-installation.js";
import {
  diffOf,
  drawDiffCard,
  filePatch,
} from "#renderer/features/repos/diff/components/InlineDiffCard.test-support.js";
import { nextFrame } from "../helpers/animation-frame.js";
import { RealMouse } from "./real-mouse.js";
import { traceAlone } from "./trace-lock.js";

/** The flow's box, in CSS pixels. */
const FLOW_HEIGHT_PX = 600;
const FLOW_WIDTH_PX = 560;

/** The long file's lines: enough that the steps are still landing while the scroll runs. */
const LONG_LINE_COUNT = 5000;

/** Frames a fill of the diffs here may take before a case gives up on it. */
const FILL_FRAME_LIMIT = 600;

/** How far a picture's color may sit from the block's ground and still match it, per channel. */
const GROUND_TOLERANCE = 4;

/** How long the trace runs on after the block fills, so the last frames' pictures arrive. */
const TRACE_SETTLE_MS = 500;

/** The trace's marks around the driven scroll, as performance marks. */
const DRIVE_MARK = "show-all-scroll-driven";
const FILLED_MARK = "show-all-block-filled";

/** The trace's events for the capture of a frame the page drew, and its picture. */
const FRAME_CAPTURED = "Capture";
const FRAME_PICTURED = "Screenshot";

/** The result a frame's capture ends with when its picture was taken. */
const CAPTURE_SUCCEEDED = 1;

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
    // The press and the trace after it run as no other page traces, so End follows the press.
    const pictures = await traceAlone(async () => {
      fireEvent.click(showAllOf(block));
      // End goes to the focused rows' scroller, the flow, which the compositor scrolls.
      return framesDrawnUntilFilled(block, async () => {
        for (const type of ["rawKeyDown", "keyUp"] as const) {
          await cdp().send("Input.dispatchKeyEvent", {
            type,
            key: "End",
            code: "End",
            windowsVirtualKeyCode: 35,
          });
        }
      });
    });

    expect(flow.scrollTop).toBeGreaterThan(0);
    expectEveryFrameDrawn(pictures, mouse, flow, block);
  });
});

/**
 * A picture of the top page for every frame the browser captured from the driven scroll until the
 * block had every row mounted. A trace's screenshot category captures the frames of the page the
 * display draws and pictures each; a capture in that span that took no picture throws, so a frame
 * left unchecked can never read as a pass.
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
        includedCategories: [
          "disabled-by-default-devtools.screenshot",
          "gpu.capture",
          "blink.user_timing",
        ],
      },
      transferMode: "ReportEvents",
    });
    try {
      // Two frames, so the capturer is running before the scroll is driven.
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
      // A picture is taken after its frame is drawn, so the trace runs on, asking for no frame,
      // until the last frame's picture is in.
      await new Promise((resolve) => {
        setTimeout(resolve, TRACE_SETTLE_MS);
      });
    } finally {
      // Ended when the case fails too, or the browser refuses every later trace.
      await session.send("Tracing.end");
      await traceEnded;
    }
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

/**
 * One trace event, as far as the cases read it: a picture's event carries its JPEG, and the start
 * of a frame's capture carries how the capture ended.
 */
interface TraceEvent {
  readonly name: string;
  readonly phase: unknown;
  readonly ts: number;
  readonly snapshot?: string;
  readonly captureResult?: number;
}

function traceEventOf(event: Readonly<Record<string, unknown>>): TraceEvent {
  const { name, ph, ts, args } = event;
  if (typeof name !== "string" || typeof ts !== "number") {
    throw new Error("the trace sent an event with no name or time");
  }
  const fields = typeof args === "object" && args !== null ? args : {};
  const snapshot = "snapshot" in fields ? fields.snapshot : undefined;
  const result = "result" in fields ? fields.result : undefined;
  return {
    name,
    phase: ph,
    ts,
    ...(typeof snapshot === "string" ? { snapshot } : {}),
    ...(typeof result === "number" ? { captureResult: result } : {}),
  };
}

/**
 * The picture of each frame captured between the two marks, in order. The capturer keeps several
 * frames in flight, so a picture can come after the next frame's capture starts; but it ends its
 * captures in the order it starts them and pictures each one that succeeds, so the nth succeeded
 * capture of the trace is its nth picture. Throws for a capture in the span that took no picture.
 */
function picturedFrames(events: readonly TraceEvent[]): readonly string[] {
  const driveTs = events.find((event) => event.name === DRIVE_MARK)?.ts;
  const filledTs = events.find((event) => event.name === FILLED_MARK)?.ts;
  if (driveTs === undefined || filledTs === undefined) {
    throw new Error("the trace holds no marks around the driven scroll");
  }
  const inOrder = (left: TraceEvent, right: TraceEvent): number => left.ts - right.ts;
  const captures = events
    .filter((event) => event.name === FRAME_CAPTURED && event.phase === "b")
    .toSorted(inOrder);
  const pictures = events.filter((event) => event.name === FRAME_PICTURED).toSorted(inOrder);
  const snapshots: string[] = [];
  let pictureIndex = 0;
  for (const capture of captures) {
    const isInSpan = capture.ts > driveTs && capture.ts < filledTs;
    if (capture.captureResult !== CAPTURE_SUCCEEDED) {
      if (isInSpan) {
        throw new Error(
          `a frame captured at ${String(capture.ts)} µs took no picture ` +
            `(capture result ${String(capture.captureResult)})`,
        );
      }
      continue;
    }
    const picture = pictures[pictureIndex];
    pictureIndex += 1;
    if (isInSpan) {
      if (picture?.snapshot === undefined) {
        throw new Error(`the picture of a frame captured at ${String(capture.ts)} µs is missing`);
      }
      snapshots.push(picture.snapshot);
    }
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
