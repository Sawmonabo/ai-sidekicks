// The structure caps, held to the window they live inside.

import { describe, expect, it } from "vitest";

import { TRANSCRIPT_WINDOW_ROW_CAP } from "../frame/frame-caps.js";
import { RUN_GROUP_VISIBLE_ROW_CAP, FIND_MATCH_CAP } from "./structure-caps.js";

describe("structure caps — against the retained window", () => {
  it("keeps one run group's body shorter than the whole retained window", () => {
    // A run group is one entry INSIDE the window and a nested scroller of its own. At
    // or above the window's cap a single run could mount as many rows as the entire
    // transcript retains, and "scrolling inside a run group is reading rather than
    // paging" would be describing the transcript rather than the run group.
    expect(RUN_GROUP_VISIBLE_ROW_CAP).toBeLessThan(TRANSCRIPT_WINDOW_ROW_CAP);
  });

  it("ranks more matches than the window can hold rows", () => {
    // The find field searches the loaded window, and its own rationale says a
    // one-character query "matches most of it". At or below the window's row cap, a
    // query matching every retained row would be truncated by the cap rather than by
    // the window — so the counter's denominator would understate a set the walk can
    // in fact reach, which is the opposite of the promise that cap exists to keep.
    expect(FIND_MATCH_CAP).toBeGreaterThan(TRANSCRIPT_WINDOW_ROW_CAP);
  });
});
