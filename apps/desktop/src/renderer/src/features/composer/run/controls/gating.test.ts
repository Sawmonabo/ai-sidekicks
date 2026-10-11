// Which run controls a run offers, by its state and its children: no driver capability takes one
// off a run, and steer, which goes to a child's queue, needs a child.

import { describe, expect, it } from "vitest";

import { offeredRunControls } from "./gating.js";

describe("the controls a run offers", () => {
  it("offers pause and interrupt on a running run, resume on a paused one, and steer with a child", () => {
    expect(offeredRunControls("running", true)).toEqual({
      primary: ["pause", "interrupt"],
      overflow: ["steer"],
    });
    expect(offeredRunControls("paused", true).primary).toEqual(["resume", "interrupt"]);
    expect(offeredRunControls("completed", true)).toEqual({ primary: [], overflow: ["steer"] });
  });

  it("offers no steer on a run with no child to take it", () => {
    expect(offeredRunControls("running", false).overflow).toEqual([]);
  });
});
