// The one rule four readings of the wire had each written for themselves.
//
// The module beside this holds the whole reasoning. What is left for a suite is the
// boundary the name records — that `""` is ABSENT — and the two ways a reader of
// wire-verbatim values goes wrong: admitting a value that is not a string because it
// is truthy, and refusing one that is because it is falsy in some other sense.

import { describe, expect, it } from "vitest";

import { readWireString } from "./wire-strings.js";

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
