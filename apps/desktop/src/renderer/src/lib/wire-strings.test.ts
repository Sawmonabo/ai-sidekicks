// The two body predicates and the values each refuses: `""` is absent, an uncomputable figure is
// not a figure, and a value of the wrong type is never admitted because it is truthy or coercible.

import { describe, expect, it } from "vitest";

import { readWireNumber, readWireString } from "./wire-strings.js";

describe("reading a wire-supplied member as a string", () => {
  it("returns a non-empty string unchanged", () => {
    expect(readWireString("run-1")).toBe("run-1");
    // Whitespace is content: nothing here trims.
    expect(readWireString(" ")).toBe(" ");
    expect(readWireString("0")).toBe("0");
  });

  it("reads the empty string as absent, which is the decision in the name", () => {
    expect(readWireString("")).toBeUndefined();
  });

  it("negative control: every non-string the wire can carry reads as absent", () => {
    // Without this, `value ? value : undefined` would satisfy every case above and pass a number,
    // object or array through to a caller expecting a string.
    for (const value of [undefined, null, 0, 1, true, false, {}, [], ["run-1"], Symbol("run")]) {
      expect(readWireString(value)).toBeUndefined();
    }
    // The value that looks most like a string: its `toString` would render in a template literal.
    expect(readWireString({ toString: () => "run-1" })).toBeUndefined();
  });
});

describe("reading a wire-supplied member as a number", () => {
  it("returns a finite number unchanged", () => {
    expect(readWireNumber(4)).toBe(4);
    expect(readWireNumber(0)).toBe(0);
    expect(readWireNumber(-1.5)).toBe(-1.5);
  });

  it("refuses the three values JavaScript calls numbers and no view may render", () => {
    // A member the daemon could not compute is not a figure; `NaN` would pass as a reading.
    expect(readWireNumber(Number.NaN)).toBeUndefined();
    expect(readWireNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(readWireNumber(Number.NEGATIVE_INFINITY)).toBeUndefined();
  });

  it("negative control: no value is coerced, the numeric string least of all", () => {
    // Without this, `Number(value)` would satisfy every case above and return `4` for `"4"`,
    // `true` and `[]`.
    for (const value of [undefined, null, "4", "", true, false, {}, [], [4]]) {
      expect(readWireNumber(value)).toBeUndefined();
    }
  });
});
