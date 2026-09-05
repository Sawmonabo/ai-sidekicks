// The two body predicates, and the values each one refuses.
//
// Worth a unit because both are one-line judgements four view families used to make
// for themselves: what counts as a present member. The cases are the refusals, since
// admitting a value is what a copy of either predicate would also do — a copy that
// disagreed would disagree about `""`, `NaN`, and the infinities, which is exactly
// what these assert.

import { describe, expect, it } from "vitest";

import { readWireNumber, readWireString } from "./wire-strings.js";

describe("a wire-supplied string", () => {
  it("reads a non-empty string and refuses everything else", () => {
    expect(readWireString("claude")).toBe("claude");
    // The decision the module's name records: a member present as `""` carries
    // nothing a reader can render, so it is absent rather than empty.
    expect(readWireString("")).toBeUndefined();
    expect(readWireString(undefined)).toBeUndefined();
    expect(readWireString(null)).toBeUndefined();
    expect(readWireString(7)).toBeUndefined();
    expect(readWireString({ toString: () => "claude" })).toBeUndefined();
  });
});

describe("a wire-supplied number", () => {
  it("reads a finite number and refuses everything else", () => {
    expect(readWireNumber(4)).toBe(4);
    expect(readWireNumber(0)).toBe(0);
    expect(readWireNumber(-1.5)).toBe(-1.5);
    // The three JavaScript calls numbers and no surface may render: a member the
    // daemon could not compute is not a figure.
    expect(readWireNumber(Number.NaN)).toBeUndefined();
    expect(readWireNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readWireNumber(Number.NEGATIVE_INFINITY)).toBeUndefined();
    // And the string form is refused rather than coerced, which is the whole point
    // of reading a wire-verbatim body through a predicate at all.
    expect(readWireNumber("4")).toBeUndefined();
    expect(readWireNumber(undefined)).toBeUndefined();
  });
});
