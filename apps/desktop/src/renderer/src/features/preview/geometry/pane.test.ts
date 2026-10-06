// The clip-and-hide arithmetic: what rectangle a pane gets and when it disappears. An ignored
// clipping ancestor or overlay paints a page over the chrome.

import { describe, expect, it } from "vitest";

import { composePaneGeometrySample, type PaneRect } from "./pane.js";
import { rect } from "./publisher.test-support.js";

describe("composePaneGeometrySample", () => {
  const visibleInput = {
    hostRect: rect(10, 10, 200, 200),
    clipRects: [] as readonly PaneRect[],
    overlayRects: [] as readonly PaneRect[],
    reason: "attach" as const,
    sampledAtMs: 7,
  };

  it("narrows the rectangle to every clipping ancestor, not just the nearest", () => {
    const sample = composePaneGeometrySample({
      ...visibleInput,
      clipRects: [rect(0, 0, 150, 400), rect(0, 0, 400, 120)],
    });
    expect(sample.rect).toStrictEqual(rect(10, 10, 140, 110));
  });

  it("yields to an overlay that intersects the pane", () => {
    const sample = composePaneGeometrySample({
      ...visibleInput,
      overlayRects: [rect(150, 150, 400, 400)],
    });
    expect(sample.visible).toBe(false);
    expect(sample.hiddenBecause).toBe("occluded");
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
