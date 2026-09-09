// What a reader's band folds remember, and what they refuse to forget.
//
// The DEFAULT is the case that matters most here: a band nobody has touched is open,
// because `superseded-bands.ts` says a rewound band "stays present but visibly past".
// A state that started shut would delete the dimmed rows from the screen by default
// and pass every other case in this file.

import { describe, expect, it } from "vitest";

import { SupersededBandCollapseState } from "./superseded-band-collapse.js";
import { supersededBandKey, type SupersededBand } from "./superseded-bands.js";

function band(targetPosition = 2): SupersededBand {
  return { runId: "run-a", epoch: 0, targetPosition, rowIds: ["a3", "a4"] };
}

describe("superseded band folds — open until somebody asks otherwise", () => {
  it("starts with every band open and nothing folded", () => {
    const collapse = new SupersededBandCollapseState();
    expect(collapse.isFolded(band())).toBe(false);
    expect(collapse.foldedBandKeys.size).toBe(0);
  });

  it("folds an open band and opens it again", () => {
    const collapse = new SupersededBandCollapseState();
    collapse.toggle(band());
    expect(collapse.isFolded(band())).toBe(true);
    collapse.toggle(band());
    expect(collapse.isFolded(band())).toBe(false);
  });

  it("folds one rewind without folding another in the same epoch", () => {
    const collapse = new SupersededBandCollapseState();
    collapse.toggle(band(2));
    expect(collapse.isFolded(band(2))).toBe(true);
    expect(collapse.isFolded(band(4))).toBe(false);
  });

  it("opens by key rather than toggling, so a jump can never fold what it reached", () => {
    const collapse = new SupersededBandCollapseState();
    const key = supersededBandKey(band());
    collapse.toggle(band());
    expect(collapse.openBandKey(key)).toBe(true);
    expect(collapse.isFolded(band())).toBe(false);
    // The second open moves nothing, which is what the caller republishes on.
    expect(collapse.openBandKey(key)).toBe(false);
    expect(collapse.isFolded(band())).toBe(false);
  });
});
