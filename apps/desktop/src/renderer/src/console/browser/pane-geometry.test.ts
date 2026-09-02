// The arithmetic of 12.3: what rectangle a pane gets, and when it has to disappear.
//
// These cases are about the failures the naive version has, not about the happy path —
// a clipping ancestor that is ignored paints a web page over the chrome, and a
// sub-pixel rectangle bleeds a hairline of a foreign page past a boundary. Every clean
// result has a control that fails, because a predicate answering "hidden" to
// everything would satisfy every visibility assertion in this file.

import { describe, expect, it } from "vitest";

import {
  composePaneGeometrySample,
  intersectRects,
  roundPaneRect,
  type PaneRect,
} from "./pane-geometry.js";

function rect(x: number, y: number, width: number, height: number): PaneRect {
  return { x, y, width, height };
}

describe("intersectRects", () => {
  it("returns the overlap of two rectangles", () => {
    expect(intersectRects(rect(0, 0, 100, 100), rect(50, 20, 100, 100))).toStrictEqual(
      rect(50, 20, 50, 80),
    );
  });

  it("returns a zero-area rectangle where they do not meet", () => {
    expect(intersectRects(rect(0, 0, 10, 10), rect(50, 50, 10, 10))).toStrictEqual(
      rect(50, 50, 0, 0),
    );
  });

  it("rounds every coordinate to two places", () => {
    expect(intersectRects(rect(0.123_45, 0.987_65, 10, 10), rect(0, 0, 10, 10))).toStrictEqual(
      rect(0.12, 0.99, 9.88, 9.01),
    );
  });

  it("negative control: overlapping rectangles do not come back zero-area", () => {
    // Without this, an implementation that returned a zero rectangle for everything
    // would satisfy both the disjoint case and every hidden-state case below.
    const overlap = intersectRects(rect(0, 0, 10, 10), rect(5, 5, 10, 10));
    expect(overlap.width).toBeGreaterThan(0);
    expect(overlap.height).toBeGreaterThan(0);
  });
});

describe("composePaneGeometrySample", () => {
  const visibleInput = {
    hostRect: rect(10, 10, 200, 200),
    clipRects: [] as readonly PaneRect[],
    overlayRects: [] as readonly PaneRect[],
    reason: "attach" as const,
    sampledAtMs: 7,
  };

  it("shows the view when nothing clips it and nothing is over it", () => {
    const sample = composePaneGeometrySample(visibleInput);
    expect(sample.visible).toBe(true);
    expect(sample.hiddenBecause).toBeUndefined();
    expect(sample.rect).toStrictEqual(rect(10, 10, 200, 200));
    expect(sample.sampledAtMs).toBe(7);
    expect(sample.reason).toBe("attach");
  });

  it("narrows the rectangle to every clipping ancestor, not just the nearest", () => {
    const sample = composePaneGeometrySample({
      ...visibleInput,
      clipRects: [rect(0, 0, 150, 400), rect(0, 0, 400, 120)],
    });
    expect(sample.rect).toStrictEqual(rect(10, 10, 140, 110));
  });

  it("hides the view outright when the clip leaves less than a pixel", () => {
    const sample = composePaneGeometrySample({
      ...visibleInput,
      clipRects: [rect(0, 0, 10.4, 400)],
    });
    expect(sample.visible).toBe(false);
    expect(sample.hiddenBecause).toBe("below-minimum-edge");
  });

  it("yields to an overlay that intersects the pane", () => {
    const sample = composePaneGeometrySample({
      ...visibleInput,
      overlayRects: [rect(150, 150, 400, 400)],
    });
    expect(sample.visible).toBe(false);
    expect(sample.hiddenBecause).toBe("occluded");
  });

  it("negative control: an overlay that misses the pane does not hide it", () => {
    // The occlusion case above would pass over a predicate that hid the view whenever
    // any overlay existed at all, which is the reading that makes the whole pane
    // unusable the moment a toast appears in a corner.
    const sample = composePaneGeometrySample({
      ...visibleInput,
      overlayRects: [rect(900, 900, 50, 50)],
    });
    expect(sample.visible).toBe(true);
  });

  it("keys equal geometry the same way and different geometry differently", () => {
    const first = composePaneGeometrySample(visibleInput);
    const again = composePaneGeometrySample({ ...visibleInput, sampledAtMs: 99 });
    const moved = composePaneGeometrySample({
      ...visibleInput,
      hostRect: rect(11, 10, 200, 200),
    });
    expect(again.key).toBe(first.key);
    expect(moved.key).not.toBe(first.key);
  });

  it("keys visibility, so a pane that only became occluded still publishes", () => {
    const shown = composePaneGeometrySample(visibleInput);
    const hidden = composePaneGeometrySample({
      ...visibleInput,
      overlayRects: [rect(0, 0, 500, 500)],
    });
    expect(hidden.key).not.toBe(shown.key);
  });
});

describe("roundPaneRect", () => {
  it("is the single rounding, so a caller's box keys the same as a composed sample", () => {
    // Deliberately not `1.005`: that value's binary representation multiplies to
    // 100.49999999999999, so it rounds DOWN — a real property of the arithmetic, and
    // not one this case is about.
    const rounded = roundPaneRect({ x: 1.014, y: 2.004, width: 3.999, height: 4.001 });
    expect(rounded).toStrictEqual(rect(1.01, 2, 4, 4));
    expect(
      composePaneGeometrySample({
        hostRect: rounded,
        clipRects: [],
        overlayRects: [],
        reason: "attach",
        sampledAtMs: 0,
      }).rect,
    ).toStrictEqual(rounded);
  });
});
