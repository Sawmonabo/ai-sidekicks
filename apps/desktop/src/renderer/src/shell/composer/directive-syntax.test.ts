// One reading of the slash prefix, and the two lines it must not claim.
//
// The cases moved here with the function: they were the discovery surface's, and the
// send router is now the second reader of the same grammar. A rule read by two zones
// is asserted once.

import { describe, expect, it } from "vitest";

import { readDirectiveName } from "./directive-syntax.js";

describe("readDirectiveName", () => {
  it("opens on a leading slash and reports the typed name", () => {
    expect(readDirectiveName("/comp")).toBe("comp");
  });

  it("opens with an empty name on the trigger alone", () => {
    expect(readDirectiveName("/")).toBe("");
  });

  it("reads only the first word, so arguments do not widen the name", () => {
    expect(readDirectiveName("/compact now please")).toBe("compact");
  });

  it("reads a line the person has indented, as both readers hand it one", () => {
    // The router trims before it asks and the popover does not, so the trimming is
    // the grammar's rather than each caller's — otherwise the two disagree on a
    // line that begins with a space.
    expect(readDirectiveName("  /compact")).toBe("compact");
  });

  it("negative control: the literal-slash escape names nothing", () => {
    expect(readDirectiveName("//not a command")).toBeUndefined();
  });

  it("negative control: ordinary prose names nothing", () => {
    expect(readDirectiveName("compact the context")).toBeUndefined();
  });
});
