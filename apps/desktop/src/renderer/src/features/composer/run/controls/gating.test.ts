// Which run controls a run offers, by its state: no driver capability takes one off a run.

import { describe, expect, it } from "vitest";

import { offeredRunControls } from "./gating.js";

describe("the controls a run offers", () => {
  it("offers pause and interrupt on a running run, resume on a paused one, none on an ended one", () => {
    expect(offeredRunControls("running")).toEqual(["pause", "interrupt"]);
    expect(offeredRunControls("paused")).toEqual(["resume", "interrupt"]);
    expect(offeredRunControls("completed")).toEqual([]);
  });
});
