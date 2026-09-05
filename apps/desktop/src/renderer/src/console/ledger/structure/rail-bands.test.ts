// The row-band model — the one geometry, driven without a rail around it.
//
// The two readings the partition produces are the same measurement, and the way that
// fails is arithmetic rather than visible: a thumb whose top is taken against the last
// INDEX while its height is taken against the row COUNT hangs off the end of the rail,
// and a mark placed on a second axis lands outside the thumb pointing at it. So the
// cases below assert the identity itself, not a rendering of it.

import { describe, expect, it } from "vitest";

import { clampRailViewportBand, railViewportBand } from "./rail-bands.js";
import { RAIL_THUMB_MIN_EXTENT } from "./structure-bounds.js";

describe("rail — the row-band model places both readings", () => {
  const WINDOW_ROW_COUNT = 100;
  const TAIL_FIRST_INDEX = 90;

  it("ends the tail viewport's thumb exactly at the rail's foot", () => {
    // The defect in one line: `firstIndex / (rowCount - 1)` plus
    // `visibleCount / rowCount` is 90.9% down plus 10% of height, and the thumb
    // hung over the end of the rail.
    const band = railViewportBand(TAIL_FIRST_INDEX, WINDOW_ROW_COUNT - 1, WINDOW_ROW_COUNT);
    expect(band.position).toBeCloseTo(0.9, 12);
    expect(band.extent).toBeCloseTo(0.1, 12);
    expect(band.position + band.extent).toBeCloseTo(1, 12);
  });

  it("negative control: the two-denominator arithmetic runs past the foot", () => {
    // Without this the case above would pass over any formula that happened to
    // land at the tail. This is what the geometry computed before, evaluated on
    // the same viewport: it overruns, which is why one denominator is the rule.
    const staleTop = TAIL_FIRST_INDEX / (WINDOW_ROW_COUNT - 1);
    const staleHeight = (WINDOW_ROW_COUNT - TAIL_FIRST_INDEX) / WINDOW_ROW_COUNT;
    expect(staleTop + staleHeight).toBeGreaterThan(1);
  });

  it("leaves a mid-window thumb where the bands put it, clamping nothing", () => {
    const band = railViewportBand(40, 44, WINDOW_ROW_COUNT);
    expect(band.position).toBeCloseTo(40 / WINDOW_ROW_COUNT, 12);
    expect(band.extent).toBeCloseTo(5 / WINDOW_ROW_COUNT, 12);
  });

  it("gives a viewport spanning every row the whole rail", () => {
    expect(railViewportBand(0, WINDOW_ROW_COUNT - 1, WINDOW_ROW_COUNT)).toStrictEqual({
      position: 0,
      extent: 1,
    });
  });

  it("pays the minimum height out of the top rather than out of the rail", () => {
    // One row of ten thousand is half a pixel of thumb, so the floor applies — and
    // the floor is taken off the TOP at the foot of the rail, never added past it.
    const band = railViewportBand(9999, 9999, 10_000);
    expect(band.extent).toBe(RAIL_THUMB_MIN_EXTENT);
    expect(band.position).toBeCloseTo(1 - RAIL_THUMB_MIN_EXTENT, 12);
  });

  it("negative control: clamping the pair independently admits a thumb past the foot", () => {
    // The clamp that shipped bounded top and height into [0, 1] separately, which
    // accepts this pair unchanged. One clamp over the pair is what rejects it.
    const overrunning = { position: 0.909, extent: 0.1 };
    expect(Math.min(1, overrunning.position) + Math.min(1, overrunning.extent)).toBeGreaterThan(1);
    const clamped = clampRailViewportBand(overrunning);
    expect(clamped.position + clamped.extent).toBeCloseTo(1, 12);
  });
});
