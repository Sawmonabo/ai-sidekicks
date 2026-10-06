// The find walk's reading: served when every match is inside the walk, cut otherwise.

import { describe, expect, it } from "vitest";

import { matchWalkReading } from "./readings.js";

describe("the find walk's reading", () => {
  it("is served when every match is inside the walk", () => {
    expect(matchWalkReading(12, 0)).toStrictEqual({ kind: "served" });
  });

  it("is cut when matches lie outside it, and leads with what was read", () => {
    expect(matchWalkReading(12, 3)).toStrictEqual({ kind: "cut", servedCount: 12 });
  });

  it("counts a walk that reached nothing as cut too", () => {
    // The arm is decided by what is hidden, so a query with every match outside the window
    // still says so, with a figure of zero.
    expect(matchWalkReading(0, 4)).toStrictEqual({ kind: "cut", servedCount: 0 });
  });
});
