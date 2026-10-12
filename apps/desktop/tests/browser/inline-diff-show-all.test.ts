// A long diff opened whole in a flow outside a transcript viewport, in Chromium. Show all mounts
// the rows a step at a time and holds no room for rows not mounted yet, so End pressed right after
// Show all, a jump the compositor scrolls, never paints a part of the block with no rows: every
// frame the browser captures meanwhile is read back from a trace and checked, except a frame the
// compositor reports drawing with tiles missing, which shows the layer's ground in their place
// whatever rows the page laid out there.

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

/** The trace's event for each frame the page's compositor drew, and how complete it was. */
const FRAME_REPORTED = "PipelineReporter";

/** The prefix of the states of a frame the compositor drew, rather than dropped or skipped. */
const FRAME_PRESENTED_STATE = "STATE_PRESENTED";

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
          "disabled-by-default-devtools.timeline.frame",
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
 * One trace event, as far as the cases read it: a picture's event carries its JPEG and the frame
 * it shows, the start of a frame's capture carries how the capture ended, and the start of a frame
 * the compositor reports carries whether it drew every tile.
 */
interface TraceEvent {
  readonly name: string;
  readonly phase: unknown;
  readonly ts: number;
  readonly pid: unknown;
  readonly snapshot?: string;
  readonly captureResult?: number;
  readonly frame?: CompositorFrame;
}

/**
 * A frame by the display's own count: its begin-frame source and sequence number, which the
 * picture of a frame and the compositor's report of it both carry.
 */
interface CompositorFrame {
  readonly source: number;
  readonly sequence: number;
  /** For a reported frame: whether the compositor drew it, and drew it with tiles missing. */
  readonly isPresented?: boolean;
  readonly isMissingTiles?: boolean;
}

function traceEventOf(event: Readonly<Record<string, unknown>>): TraceEvent {
  const { name, ph, ts, pid, args } = event;
  if (typeof name !== "string" || typeof ts !== "number") {
    throw new Error("the trace sent an event with no name or time");
  }
  const fields = (typeof args === "object" && args !== null ? args : {}) as Readonly<
    Record<string, unknown>
  >;
  const { snapshot, result } = fields;
  const frame = name === FRAME_PICTURED ? picturedFrameOf(fields) : reportedFrameOf(fields);
  return {
    name,
    phase: ph,
    ts,
    pid,
    ...(typeof snapshot === "string" ? { snapshot } : {}),
    ...(typeof result === "number" ? { captureResult: result } : {}),
    ...(frame === undefined ? {} : { frame }),
  };
}

function picturedFrameOf(fields: Readonly<Record<string, unknown>>): CompositorFrame | undefined {
  const { source_id: source, frame_sequence: sequence } = fields;
  return typeof source === "number" && typeof sequence === "number"
    ? { source, sequence }
    : undefined;
}

function reportedFrameOf(fields: Readonly<Record<string, unknown>>): CompositorFrame | undefined {
  const report = fields["frame_reporter"];
  if (typeof report !== "object" || report === null) {
    return undefined;
  }
  const {
    frame_source: source,
    frame_sequence: sequence,
    state,
    checkerboarded_needs_raster: needsRaster,
    checkerboarded_needs_record: needsRecord,
    has_missing_content: hasMissingContent,
  } = report as Readonly<Record<string, unknown>>;
  if (typeof source !== "number" || typeof sequence !== "number") {
    return undefined;
  }
  return {
    source,
    sequence,
    isPresented: typeof state === "string" && state.startsWith(FRAME_PRESENTED_STATE),
    isMissingTiles: needsRaster === true || needsRecord === true || hasMissingContent === true,
  };
}

/**
 * The picture of each frame captured between the two marks, in order. The capturer keeps several
 * frames in flight, so a picture can come after the next frame's capture starts; but it ends its
 * captures in the order it starts them and pictures each one that succeeds, so the nth succeeded
 * capture of the trace is its nth picture. Throws for a capture in the span that took no picture.
 *
 * A picture of a frame the page's compositor drew with tiles missing is left out: on a busy machine
 * the main thread's painting or the rasterizer can fall behind a jump, and the compositor then
 * fills the tiles not yet drawn with the layer's ground, whatever rows the page laid out there.
 * Throws when that leaves no frame.
 */
function picturedFrames(events: readonly TraceEvent[]): readonly string[] {
  const driveMark = events.find((event) => event.name === DRIVE_MARK);
  const filledTs = events.find((event) => event.name === FILLED_MARK)?.ts;
  if (driveMark === undefined || filledTs === undefined) {
    throw new Error("the trace holds no marks around the driven scroll");
  }
  const driveTs = driveMark.ts;
  // The marks are the page's own, so its renderer is the process whose frames the pictures show.
  const reportedFrames = events.flatMap((event) =>
    event.name === FRAME_REPORTED && event.phase === "b" && event.pid === driveMark.pid
      ? (event.frame ?? [])
      : [],
  );
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
      if (!isDrawnWithTilesMissing(picture, reportedFrames)) {
        snapshots.push(picture.snapshot);
      }
    }
  }
  if (snapshots.length === 0) {
    throw new Error("no frame drawn with every tile was pictured while the block filled");
  }
  return snapshots;
}

/**
 * Whether the compositor drew the frame `picture` shows with tiles missing: the last frame it drew
 * at or before the picture's place in the display's count, since a frame the page did not update
 * shows the one before. A picture the trace cannot place is checked.
 */
function isDrawnWithTilesMissing(
  picture: TraceEvent,
  reportedFrames: readonly CompositorFrame[],
): boolean {
  const pictured = picture.frame;
  if (pictured === undefined) {
    return false;
  }
  let shown: CompositorFrame | undefined;
  for (const reported of reportedFrames) {
    if (
      reported.isPresented === true &&
      reported.source === pictured.source &&
      reported.sequence <= pictured.sequence &&
      (shown === undefined || reported.sequence > shown.sequence)
    ) {
      shown = reported;
    }
  }
  return shown?.isMissingTiles === true;
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
