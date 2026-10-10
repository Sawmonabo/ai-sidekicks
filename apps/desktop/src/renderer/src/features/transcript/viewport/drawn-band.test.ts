// The band a window nested in a row draws its items within, against the rows' own band. A fling's
// first frame can carry the box further than the band before a render draws, so before the reader
// has moved one way the nested windows reach as far as a leading side on every side the box can
// still move toward.

import { describe, expect, it } from "vitest";

import { ManualClock } from "#renderer/lib/clock.js";
import { type ScrollGeometry } from "#renderer/lib/scroll/geometry/sample.js";
import {
  TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS,
  TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS,
} from "./caps.js";
import { ViewportDrawnBand } from "./drawn-band.js";

const VIEWPORT_HEIGHT_PX = 600;
const CONTENT_HEIGHT_PX = 6_000;
const SIDE = TRANSCRIPT_DRAWN_BAND_SCREEN_HEIGHTS;
const LEADING = TRANSCRIPT_LEADING_BAND_SCREEN_HEIGHTS;

/** A whole band, as it stands once the opening has landed, and how often it published. */
function wholeBand(): { readonly band: ViewportDrawnBand; readonly publishCount: () => number } {
  let publishCount = 0;
  const band = new ViewportDrawnBand({
    clock: new ManualClock(),
    isLanding: () => false,
    redraw: () => {},
    publish: () => {
      publishCount += 1;
    },
  });
  band.widenFully();
  return { band, publishCount: () => publishCount };
}

/** A sample of the box at `scrollTop`, published by a write when `inputAt` is absent. */
function sampleAt(scrollTop: number, inputAt?: number): ScrollGeometry {
  const distanceFromTailPx = CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX - scrollTop;
  return {
    scrollTop,
    viewportHeight: VIEWPORT_HEIGHT_PX,
    contentHeight: CONTENT_HEIGHT_PX,
    distanceFromTailPx,
    isAtTail: distanceFromTailPx <= 0,
    inputAt,
    cause: "scroll",
  };
}

describe("the band a window nested in a row draws within", () => {
  it("leads every way a resting box can move, while the rows' band stays even", () => {
    const { band, publishCount } = wholeBand();

    band.observeGeometry(sampleAt(2_000));
    expect(band.nestedScreenHeights).toStrictEqual({ head: LEADING, tail: LEADING });
    expect(band.screenHeights).toStrictEqual({ head: SIDE, tail: SIDE });

    // At an end the box can move only away from it, so only that side leads.
    const publishedBeforeHead = publishCount();
    band.observeGeometry(sampleAt(0));
    expect(band.nestedScreenHeights).toStrictEqual({ head: SIDE, tail: LEADING });
    expect(publishCount()).toBe(publishedBeforeHead + 1);
    band.observeGeometry(sampleAt(CONTENT_HEIGHT_PX - VIEWPORT_HEIGHT_PX));
    expect(band.nestedScreenHeights).toStrictEqual({ head: LEADING, tail: SIDE });
    expect(band.screenHeights).toStrictEqual({ head: SIDE, tail: SIDE });
  });

  it("is the rows' own band once the reader has moved one way, and narrows with a land", () => {
    const { band } = wholeBand();
    band.observeGeometry(sampleAt(2_000));

    band.observeGeometry(sampleAt(2_400, 1));
    expect(band.nestedScreenHeights).toBe(band.screenHeights);
    expect(band.nestedScreenHeights).toStrictEqual({ head: SIDE, tail: LEADING });

    band.narrow();
    expect(band.nestedScreenHeights).toStrictEqual({ head: 0, tail: 0 });
  });
});
