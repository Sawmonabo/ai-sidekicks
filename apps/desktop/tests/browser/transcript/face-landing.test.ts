// A face that lands while a session is open, as a split the sheet declares lands the first time a
// run needs it, measures every row drawn in it again with no input from the reader. A reader
// reading back stays where they were: the row crossing the box's top keeps its place in every
// painted frame. A reader following the tail stays at the tail in every painted frame. Both hold
// for a face loaded whole and for a symbol's split, which the browser fetches only once a row
// draws one of its symbols.

import piSplitUrl from "@ibm/plex-sans-variable/fonts/split/woff2/IBM Plex Sans Var-Roman-Pi.woff2?url";
import { describe, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { pagedSessionEventAt } from "#renderer/features/transcript/logs.test-support.js";
import type { ProjectedSessionEvent } from "#renderer/store/session/entities/vocabulary.js";
import { TYPEFACE_FACES } from "#renderer/styles/typeface.js";
import { letFramesPass } from "../../helpers/animation-frame.js";
import {
  FEED_HEIGHT_PX,
  ROW_SELECTOR,
  endGesture,
  mountLongToolHistory,
  mountPagedHistory,
  positionOfRow,
} from "./long-tool-feed.js";
import { PaintedFrameReader } from "./painted-frames.js";

/** Screens the reader wheels toward the head at least, before reading still. */
const READ_BACK_SCREEN_COUNT = 3;
/** How far above the box's top the reader leaves a run's header before the face lands. */
const HEADER_ABOVE_BOX_PX = 20;
/** Frames watched once the face lands: its new measure and the list's answer to it. */
const WATCH_FRAME_COUNT = 20;
/** The family landed again: a tool row's text draws in it, beside the mono figures. */
const LANDED_FAMILY = "IBM Plex Sans";
/** Its baseline far lower in its line than the mono face's, so every tool row grows a pixel. */
const LANDED_ASCENT_OVERRIDE = "200%";
const LANDED_DESCENT_OVERRIDE = "0%";

/** Messages in the log the split lands over, each wrapping over several lines of arrows. */
const ARROW_MESSAGE_COUNT = 400;
const ARROW_STEPS_PER_MESSAGE = 40;
/** The arrows block, the range the sans family's symbol split covers. */
const ARROW_RANGE = "U+2190-21FF";
/** Wider than the host face draws them, so every message wraps onto more lines once it lands. */
const LANDED_ARROW_SIZE_ADJUST = "300%";

/** Lands the sans faces again, measured unlike the shipped ones, until the case ends. */
async function landTallerFaces(): Promise<void> {
  const faces = TYPEFACE_FACES.filter((face) => face.family === LANDED_FAMILY).map(
    (face) =>
      new FontFace(face.family, `url("${face.url}") format("woff2")`, {
        style: face.style,
        weight: face.weightRange,
        ...(face.stretchRange === null ? {} : { stretch: face.stretchRange }),
        ascentOverride: LANDED_ASCENT_OVERRIDE,
        descentOverride: LANDED_DESCENT_OVERRIDE,
      }),
  );
  await Promise.all(faces.map((face) => face.load()));
  onTestFinished(() => {
    for (const face of faces) {
      document.fonts.delete(face);
    }
  });
  for (const face of faces) {
    document.fonts.add(face);
  }
}

/**
 * Declares the sans family's symbol split for the arrows, as the sheet declares one, until the case
 * ends: the browser fetches it only once a row draws an arrow. Answers the declared face.
 */
function declareArrowSplit(): FontFace {
  // `size-adjust` is a descriptor the engine reads that the DOM's types do not list.
  const descriptors: FontFaceDescriptors & { readonly sizeAdjust: string } = {
    weight: "100 700",
    unicodeRange: ARROW_RANGE,
    sizeAdjust: LANDED_ARROW_SIZE_ADJUST,
  };
  const split = new FontFace("IBM Plex Sans", `url("${piSplitUrl}") format("woff2")`, descriptors);
  onTestFinished(() => {
    document.fonts.delete(split);
  });
  document.fonts.add(split);
  return split;
}

/** A log of messages, each named for its place, every one drawing arrows. */
function arrowMessages(): ProjectedSessionEvent[] {
  return Array.from({ length: ARROW_MESSAGE_COUNT }, (_, index) => ({
    ...pagedSessionEventAt(index),
    payload: {
      message: [
        `Message ${String(index)}:`,
        ...Array.from(
          { length: ARROW_STEPS_PER_MESSAGE },
          (_unused, step) => `step ${String(step)} → next`,
        ),
      ].join(" "),
    },
  }));
}

/** The log position a drawn message row names, read from its text. */
function positionOfMessage(row: Element): number | undefined {
  const match = /Message (\d+):/u.exec(row.textContent);
  return match === null ? undefined : Number(match[1]);
}

/** The drawn row crossing the box's top, and how far its top stands below the box's top. */
function rowAtBoxTop(
  scroller: HTMLElement,
  positionOf: (row: Element) => number | undefined,
): { readonly position: number; readonly topPx: number } {
  const box = scroller.getBoundingClientRect();
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const rect = row.getBoundingClientRect();
    const position = positionOf(row);
    if (position !== undefined && rect.top <= box.top && rect.bottom > box.top) {
      return { position, topPx: rect.top - box.top };
    }
  }
  return expect.fail("a row crosses the box's top");
}

/**
 * How far below the box's top the first drawn run header at or below it ends, a drawn row naming
 * no tool, or `undefined` when none is drawn there.
 */
function runHeaderBottomBelowBoxTop(scroller: HTMLElement): number | undefined {
  const box = scroller.getBoundingClientRect();
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const rect = row.getBoundingClientRect();
    if (positionOfRow(row) === undefined && rect.top >= box.top) {
      return rect.bottom - box.top;
    }
  }
  return undefined;
}

/** Where the row at `position` stands below the box's top, or `undefined` once it is not drawn. */
function topOfRow(
  scroller: HTMLElement,
  positionOf: (row: Element) => number | undefined,
  position: number,
): number | undefined {
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (positionOf(row) === position) {
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }
  }
  return undefined;
}

/**
 * How far the list's last drawn row ends below the box's bottom, read from the layout rather than
 * the rounded scroll extent, so a follower's place is told to the device pixel.
 */
function tailBelowBoxPx(scroller: HTMLElement): number {
  const rows = [...scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
  const tailBottomPx = Math.max(...rows.map((row) => row.getBoundingClientRect().bottom));
  return tailBottomPx - scroller.getBoundingClientRect().bottom;
}

/** Lands a face through `land` and answers what `read` found in each painted frame meanwhile. */
async function readEachFrameAsFaceLands<Value>(
  land: () => Promise<void>,
  read: () => Value,
): Promise<Value[]> {
  const painted: Value[] = [];
  const frames = new PaintedFrameReader(ROW_SELECTOR, read, (value) => {
    painted.push(value);
  });
  await land();
  await letFramesPass(WATCH_FRAME_COUNT);
  frames.stop();
  return painted;
}

describe("a face landing while a session is open", () => {
  it("keeps a reader reading back where they were in every painted frame", async () => {
    const { scroller } = await mountLongToolHistory();
    await document.fonts.ready;
    // Back toward the head until a run's header is drawn below the box's top, then down past it:
    // the landed face grows a header's line, so it grows above the reader.
    let headerBottomPx: number | undefined;
    for (
      let screen = 0;
      screen < READ_BACK_SCREEN_COUNT || headerBottomPx === undefined;
      screen += 1
    ) {
      await userEvent.wheel(scroller, { delta: { y: -FEED_HEIGHT_PX } });
      await endGesture(scroller);
      headerBottomPx = runHeaderBottomBelowBoxTop(scroller);
    }
    await userEvent.wheel(scroller, { delta: { y: headerBottomPx + HEADER_ABOVE_BOX_PX } });
    await endGesture(scroller);
    const reference = rowAtBoxTop(scroller, positionOfRow);
    const heightBeforePx = scroller.scrollHeight;

    const tops = await readEachFrameAsFaceLands(landTallerFaces, () =>
      topOfRow(scroller, positionOfRow, reference.position),
    );

    // The control: the rows grew, so the list moved everything it holds.
    expect(scroller.scrollHeight).toBeGreaterThan(heightBeforePx);
    const strayTops = tops.filter(
      (topPx) => topPx === undefined || Math.abs(topPx - reference.topPx) >= 1,
    );
    expect(strayTops).toEqual([]);
  });

  it("keeps a reader following the tail at the tail in every painted frame", async () => {
    const { scroller } = await mountLongToolHistory();
    await document.fonts.ready;
    await letFramesPass(2);
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeLessThan(1);
    const tailBeforePx = tailBelowBoxPx(scroller);
    const heightBeforePx = scroller.scrollHeight;

    const tails = await readEachFrameAsFaceLands(landTallerFaces, () => tailBelowBoxPx(scroller));

    expect(scroller.scrollHeight).toBeGreaterThan(heightBeforePx);
    expect(tails.filter((tailPx) => Math.abs(tailPx - tailBeforePx) >= 1)).toEqual([]);
  });
});

describe("a symbol's split landing while a session is open", () => {
  /** Declares the split and waits for the browser to fetch it for the arrows the rows draw. */
  const landArrowSplit = async (): Promise<void> => {
    const split = declareArrowSplit();
    // The control: nothing asked for it but the rows' arrows.
    await expect.poll(() => split.status).toBe("loaded");
  };

  it("keeps a reader reading back where they were in every painted frame", async () => {
    const { scroller } = await mountPagedHistory(arrowMessages());
    await document.fonts.ready;
    for (let screen = 0; screen < READ_BACK_SCREEN_COUNT; screen += 1) {
      await userEvent.wheel(scroller, { delta: { y: -FEED_HEIGHT_PX } });
      await endGesture(scroller);
    }
    const reference = rowAtBoxTop(scroller, positionOfMessage);
    const heightBeforePx = scroller.scrollHeight;

    const tops = await readEachFrameAsFaceLands(landArrowSplit, () =>
      topOfRow(scroller, positionOfMessage, reference.position),
    );

    // The control: the messages wrapped onto more lines, so the list moved everything it holds.
    expect(scroller.scrollHeight).toBeGreaterThan(heightBeforePx);
    const strayTops = tops.filter(
      (topPx) => topPx === undefined || Math.abs(topPx - reference.topPx) >= 1,
    );
    expect(strayTops).toEqual([]);
  });

  it("keeps a reader following the tail at the tail in every painted frame", async () => {
    const { scroller } = await mountPagedHistory(arrowMessages());
    await document.fonts.ready;
    await letFramesPass(2);
    expect(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight).toBeLessThan(1);
    const tailBeforePx = tailBelowBoxPx(scroller);
    const heightBeforePx = scroller.scrollHeight;

    const tails = await readEachFrameAsFaceLands(landArrowSplit, () => tailBelowBoxPx(scroller));

    expect(scroller.scrollHeight).toBeGreaterThan(heightBeforePx);
    expect(tails.filter((tailPx) => Math.abs(tailPx - tailBeforePx) >= 1)).toEqual([]);
  });
});
