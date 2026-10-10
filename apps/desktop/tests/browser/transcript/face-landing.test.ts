// A face that lands while a session is open, as a split the sheet declares lands the first time a
// run needs it, measures every row drawn in it again with no input from the reader. A reader
// reading back stays where they were: the row crossing the box's top keeps its place in every
// painted frame. A reader following the tail stays at the tail in every painted frame.

import { describe, expect, it, onTestFinished } from "vitest";
import { userEvent } from "vitest/browser";

import { TYPEFACE_FACES } from "#renderer/styles/typeface.js";
import { letFramesPass } from "../../helpers/animation-frame.js";
import {
  FEED_HEIGHT_PX,
  ROW_SELECTOR,
  endGesture,
  mountLongToolHistory,
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

/** The drawn row crossing the box's top, and how far its top stands below the box's top. */
function rowAtBoxTop(scroller: HTMLElement): { readonly position: number; readonly topPx: number } {
  const box = scroller.getBoundingClientRect();
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const rect = row.getBoundingClientRect();
    const position = positionOfRow(row);
    if (position !== undefined && rect.top <= box.top && rect.bottom > box.top) {
      return { position, topPx: rect.top - box.top };
    }
  }
  return expect.fail("a tool row crosses the box's top");
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
function topOfRow(scroller: HTMLElement, position: number): number | undefined {
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (positionOfRow(row) === position) {
      return row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    }
  }
  return undefined;
}

/** How far the scroll offset stands from the end of the list. */
function distanceFromTailPx(scroller: HTMLElement): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

/** Lands the taller faces and answers what `read` found in each painted frame meanwhile. */
async function readEachFrameAsFacesLand<Value>(read: () => Value): Promise<Value[]> {
  const painted: Value[] = [];
  const frames = new PaintedFrameReader(ROW_SELECTOR, read, (value) => {
    painted.push(value);
  });
  await landTallerFaces();
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
      await endGesture();
      headerBottomPx = runHeaderBottomBelowBoxTop(scroller);
    }
    await userEvent.wheel(scroller, { delta: { y: headerBottomPx + HEADER_ABOVE_BOX_PX } });
    await endGesture();
    const reference = rowAtBoxTop(scroller);
    const heightBeforePx = scroller.scrollHeight;

    const tops = await readEachFrameAsFacesLand(() => topOfRow(scroller, reference.position));

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
    expect(distanceFromTailPx(scroller)).toBeLessThan(1);
    const heightBeforePx = scroller.scrollHeight;

    const distances = await readEachFrameAsFacesLand(() => distanceFromTailPx(scroller));

    expect(scroller.scrollHeight).toBeGreaterThan(heightBeforePx);
    expect(distances.filter((distancePx) => distancePx >= 1)).toEqual([]);
  });
});
