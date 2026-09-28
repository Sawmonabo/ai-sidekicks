// One reading of the slash prefix, and the two lines it must not claim.
//
// The discovery surface and the send router read the same grammar, so a rule both
// zones depend on is asserted once, here.

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

  it("negative control: an indented line is prose, so it names nothing", () => {
    // The router hands over the user's text untouched, so pasted code whose first
    // non-blank character is a slash would otherwise be claimed as a command. A
    // command occupies its line from the first byte.
    expect(readDirectiveName("  /compact")).toBeUndefined();
  });

  it("reads a doubled slash as the name it is, so nothing recognises it", () => {
    expect(readDirectiveName("//not a command")).toBe("/not");
  });

  it("negative control: ordinary prose names nothing", () => {
    expect(readDirectiveName("compact the context")).toBeUndefined();
  });
});
