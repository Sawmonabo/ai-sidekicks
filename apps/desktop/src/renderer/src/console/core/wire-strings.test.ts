// The two body predicates, and the values each one refuses.
//
// The module beside this holds the whole reasoning. What is left for a suite is the
// boundary each name records — that `""` is ABSENT, and that a figure the daemon
// could not compute is not a figure — and the two ways a reader of wire-verbatim
// values goes wrong: admitting a value of the wrong type because it is truthy or
// coercible, and refusing one of the right type because it is falsy in some other
// sense.

import { describe, expect, it } from "vitest";

import { readWireNumber, readWireString } from "./wire-strings.js";

describe("reading a wire-supplied member as a string", () => {
  it("returns a non-empty string unchanged", () => {
    expect(readWireString("run-1")).toBe("run-1");
    // Whitespace is content: nothing here trims, because a member the daemon sent
    // with a space in it is a member the daemon sent.
    expect(readWireString(" ")).toBe(" ");
    expect(readWireString("0")).toBe("0");
  });

  it("reads the empty string as absent, which is the decision in the name", () => {
    expect(readWireString("")).toBeUndefined();
  });

  it("negative control: every non-string the wire can carry reads as absent", () => {
    // Without this, a reader written as `value ? value : undefined` would satisfy
    // every case above and hand a number, an object, or an array straight through to
    // a caller that has already decided it is holding a string.
    for (const value of [undefined, null, 0, 1, true, false, {}, [], ["run-1"], Symbol("run")]) {
      expect(readWireString(value)).toBeUndefined();
    }
    // The one that looks most like a string and is not: a value whose `toString`
    // would render correctly everywhere a template literal reaches it.
    expect(readWireString({ toString: () => "run-1" })).toBeUndefined();
  });
});

describe("reading a wire-supplied member as a number", () => {
  it("returns a finite number unchanged", () => {
    expect(readWireNumber(4)).toBe(4);
    expect(readWireNumber(0)).toBe(0);
    expect(readWireNumber(-1.5)).toBe(-1.5);
  });

  it("refuses the three values JavaScript calls numbers and no surface may render", () => {
    // A member the daemon could not compute is not a figure, and rendering one would
    // put `NaN` in front of a person as though it were a reading.
    expect(readWireNumber(Number.NaN)).toBeUndefined();
    expect(readWireNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readWireNumber(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it("negative control: no value is coerced, the numeric string least of all", () => {
    // Without this, a reader written as `Number(value)` would satisfy every case
    // above and hand `4` back for the string `"4"`, for `true`, and for `[]` — which
    // is the whole reason a wire-verbatim body is read through a predicate at all.
    for (const value of [undefined, null, "4", "", true, false, {}, [], [4]]) {
      expect(readWireNumber(value)).toBeUndefined();
    }
  });
});
