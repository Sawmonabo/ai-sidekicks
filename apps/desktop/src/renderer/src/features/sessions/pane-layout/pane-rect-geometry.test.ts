// The dedupe key: which differences between two measurements are the same write.

import { describe, expect, it } from "vitest";

import { rectKey, type TrackedRect } from "./pane-rect-geometry.js";

/** One measured pane, as the tracker queues it. */
const MEASURED_PANE: TrackedRect = {
  paneId: "pane-1",
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  isVisible: true,
};

describe("rectKey", () => {
  it("ignores a sub-pixel difference no one can see", () => {
    expect(rectKey({ ...MEASURED_PANE, width: 400.2 })).toBe(rectKey(MEASURED_PANE));
  });

  it("negative control: visibility is part of the key", () => {
    expect(rectKey({ ...MEASURED_PANE, isVisible: false })).not.toBe(rectKey(MEASURED_PANE));
  });
});
