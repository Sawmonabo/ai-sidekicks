// Which run controls a run offers, by its state alone: no driver capability takes one off a run.

import { describe, expect, it } from "vitest";

import { offeredRunControls } from "./gating.js";

describe("the controls a run offers", () => {
  it("offers pause and interrupt on a running run, resume on a paused one, and steer on any", () => {
    expect(offeredRunControls("running")).toEqual({
      primary: ["pause", "interrupt"],
      overflow: ["steer"],
    });
    expect(offeredRunControls("paused").primary).toEqual(["resume", "interrupt"]);
    expect(offeredRunControls("completed")).toEqual({ primary: [], overflow: ["steer"] });
  });
});
