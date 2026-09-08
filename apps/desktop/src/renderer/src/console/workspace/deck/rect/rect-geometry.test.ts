// The dedupe key: which differences between two measurements are the same write.
//
// Co-located with the algebra rather than left in the tracker's suite, because the
// key is what the tracker CONSULTS and not something it decides — a case that lived
// beside the scheduler would read as an assertion about when a write happens, which
// is the one thing it says nothing about.

import { describe, expect, it } from "vitest";

import { rectKey, type TrackedRect } from "./rect-geometry.js";

/** One measured pane, as the tracker would queue it. */
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
