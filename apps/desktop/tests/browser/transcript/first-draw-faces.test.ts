// A transcript's first rows are shown only once the faces their text asks for have landed: a face
// the first screen needs and nobody has loaded yet is asked for by the hidden rows' layout and
// waited on, so no painted frame shows a row in the fallback, and the first frame shown is already
// where it stays, at the tail, with no correction after it.

import { afterEach, describe, expect, it } from "vitest";

import { TYPEFACE_FACES } from "#renderer/styles/typeface.js";
import { letFramesPass } from "../../helpers/animation-frame.js";
import { ROW_SELECTOR, mountLongToolFeed } from "./long-tool-feed.js";
import { PaintedFrameReader } from "./painted-frames.js";

/** The family the tool rows' text draws in. */
const ROW_FAMILY = "IBM Plex Sans";
/** Frames watched once the feed has mounted. */
const WATCH_FRAME_COUNT = 10;

/** What one painted frame shows. */
interface PaintedFeed {
  readonly isShown: boolean;
  readonly faceStatus: FontFaceLoadStatus;
  readonly distanceFromTailPx: number;
  readonly scrollTopPx: number;
}

let addedFace: FontFace | undefined;

afterEach(() => {
  if (addedFace !== undefined) {
    document.fonts.delete(addedFace);
    addedFace = undefined;
  }
});

/**
 * Adds an upright face of the rows' family that nothing has loaded, measured unlike the shipped
 * one: as the last face declared it is the one the rows' text asks for.
 */
function addUnloadedRowFace(): FontFace {
  const shipped =
    TYPEFACE_FACES.find((face) => face.family === ROW_FAMILY && face.style === "normal") ??
    expect.fail("the sheet declares the rows' upright face");
  const face = new FontFace(shipped.family, `url("${shipped.url}") format("woff2")`, {
    style: shipped.style,
    weight: shipped.weightRange,
    ...(shipped.stretchRange === null ? {} : { stretch: shipped.stretchRange }),
    ascentOverride: "200%",
    descentOverride: "0%",
  });
  document.fonts.add(face);
  addedFace = face;
  return face;
}

/**
 * Starts reading each painted frame once the list's first row mounts, as the reader requires, and
 * hands `onChange` each change to the document as it is made, before anything paints it.
 */
function readFramesFromFirstRow(
  read: () => PaintedFeed,
  onChange: () => void,
): {
  readonly painted: PaintedFeed[];
  readonly stop: () => void;
} {
  const painted: PaintedFeed[] = [];
  let frames: PaintedFrameReader<PaintedFeed> | undefined;
  const changes = new MutationObserver(() => {
    onChange();
    if (frames === undefined && document.querySelector(ROW_SELECTOR) !== null) {
      frames = new PaintedFrameReader(ROW_SELECTOR, read, (value) => {
        painted.push(value);
      });
    }
  });
  changes.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });
  return {
    painted,
    stop: () => {
      changes.disconnect();
      frames?.stop();
    },
  };
}

describe("a transcript's first draw", () => {
  it("shows no row before the faces its rows ask for land, and no frame it corrects after", async () => {
    const face = addUnloadedRowFace();
    const viewportSelector = ".meridian-transcript-viewport";
    const isShown = (viewport: Element): boolean =>
      getComputedStyle(viewport).visibility === "visible";
    // The face's state each time the document changes with rows in a shown viewport: a load still
    // under way there is a row a frame could paint in the fallback, however fast the load ends.
    const faceWhileShown: FontFaceLoadStatus[] = [];
    const frames = readFramesFromFirstRow(
      () => {
        const viewport = document.querySelector(viewportSelector) ?? expect.fail("a viewport");
        const scroller =
          viewport.querySelector<HTMLElement>(".meridian-transcript-viewport__scroll-container") ??
          expect.fail("a scroller");
        return {
          isShown: isShown(viewport),
          faceStatus: face.status,
          distanceFromTailPx: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
          scrollTopPx: scroller.scrollTop,
        };
      },
      () => {
        const viewport = document.querySelector(viewportSelector);
        if (
          viewport !== null &&
          isShown(viewport) &&
          viewport.querySelector(ROW_SELECTOR) !== null
        ) {
          faceWhileShown.push(face.status);
        }
      },
    );

    await mountLongToolFeed();
    await letFramesPass(WATCH_FRAME_COUNT);
    frames.stop();

    const shown = frames.painted.filter((frame) => frame.isShown);
    // The control: the rows asked for the face, and the feed was shown.
    expect(face.status).toBe("loaded");
    expect(shown.length).toBeGreaterThan(0);
    expect(faceWhileShown.length).toBeGreaterThan(0);
    expect(faceWhileShown.filter((status) => status !== "loaded")).toEqual([]);
    expect(shown.filter((frame) => frame.faceStatus !== "loaded")).toEqual([]);
    expect(shown.filter((frame) => frame.distanceFromTailPx >= 1)).toEqual([]);
    expect(new Set(shown.map((frame) => frame.scrollTopPx)).size).toBe(1);
  });
});
