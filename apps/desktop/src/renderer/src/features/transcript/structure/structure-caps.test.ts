// The structure caps, held to the window they live inside.

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_WINDOW_ROW_CAP } from "../frame/frame-caps.js";
import { RUN_GROUP_VISIBLE_ROW_CAP, FIND_MATCH_CAP } from "./structure-caps.js";

describe("structure caps — against the retained window", () => {
  it("keeps one run group's body shorter than the whole retained window", () => {
    // A run group is one entry inside the window; at or above the window cap a single run
    // could mount as many rows as the whole transcript retains.
    expect(RUN_GROUP_VISIBLE_ROW_CAP).toBeLessThan(TRANSCRIPT_WINDOW_ROW_CAP);
  });

  it("ranks more matches than the window can hold rows", () => {
    // At or below the window's row cap, a query matching every retained row would be truncated
    // by the cap rather than the window, and the denominator would understate the reachable set.
    expect(FIND_MATCH_CAP).toBeGreaterThan(TRANSCRIPT_WINDOW_ROW_CAP);
  });
});
