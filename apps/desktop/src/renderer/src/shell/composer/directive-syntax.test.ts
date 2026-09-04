// One reading of the slash prefix, and the two lines it must not claim.
//
// The cases moved here with the function: they were the discovery surface's, and the
// send router is now the second reader of the same grammar. A rule read by two zones
// is asserted once.

import { describe, expect, it } from "vitest";

import {
  opensDirectiveLine,
  readDirectiveName,
  stripLiteralSlashEscape,
} from "./directive-syntax.js";

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
    // The grammar used to trim the line first, which made this "compact". It cannot,
    // because the router now hands over the participant's text untouched: pasted
    // code whose first non-blank character is a slash would otherwise be claimed as
    // a command. A command occupies its line from the first byte.
    expect(readDirectiveName("  /compact")).toBeUndefined();
  });

  it("negative control: the literal-slash escape names nothing", () => {
    expect(readDirectiveName("//not a command")).toBeUndefined();
  });

  it("negative control: ordinary prose names nothing", () => {
    expect(readDirectiveName("compact the context")).toBeUndefined();
  });
});

describe("opensDirectiveLine", () => {
  it("claims the trigger at the first byte, the escape included", () => {
    expect(opensDirectiveLine("/compact")).toBe(true);
    expect(opensDirectiveLine("//literal")).toBe(true);
  });

  it("negative control: leaves indented and unprefixed text to prose", () => {
    expect(opensDirectiveLine("  /compact")).toBe(false);
    expect(opensDirectiveLine("compact")).toBe(false);
  });
});

describe("stripLiteralSlashEscape", () => {
  it("takes exactly one character off an escaped line and nothing else", () => {
    expect(stripLiteralSlashEscape("//not-a-command")).toBe("/not-a-command");
    // Whitespace the person wrote is theirs: the strip is a strip, not a trim.
    expect(stripLiteralSlashEscape("//  spaced  ")).toBe("/  spaced  ");
  });

  it("negative control: returns an unescaped line byte-identical", () => {
    expect(stripLiteralSlashEscape("  /compact  ")).toBe("  /compact  ");
    expect(stripLiteralSlashEscape("/compact")).toBe("/compact");
  });
});
