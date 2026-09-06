// What the span parse leaves behind, and what a body's own bytes say about its shape.
//
// Both claims are measured against the pinned `anser`: it consumes CSI sequences and
// leaves OSC and the two-byte escapes inside the chunk it hands back. Every case below
// is a sequence family a real shell emits, and the negative controls are the two ways
// the strip could be wrong — taking text with it, or firing on a body that has none.

import { describe, expect, it } from "vitest";

import { carriesAnsiEscapes, withoutResidualEscapes } from "./escape-sequences.js";

const ESCAPE = "\u001b";
const BACKSLASH = "\\";
const BELL = "\u0007";

describe("whether a body is command output", () => {
  it("reads an escape sequence as command output", () => {
    expect(carriesAnsiEscapes(`${ESCAPE}[31mfailed`)).toBe(true);
  });

  it("negative control: ordinary prose is not command output", () => {
    // Without this the reading would answer "ANSI" for every body, which is what put
    // a web-search answer in a raw block with its markdown showing.
    expect(carriesAnsiEscapes("an ordinary **reply**\nover two lines\twith a tab")).toBe(false);
  });
});

describe("the residue a span parse leaves behind", () => {
  it("removes an operating-system command terminated by BEL", () => {
    expect(withoutResidualEscapes(`${ESCAPE}]0;a title${BELL}built`)).toBe("built");
  });

  it("removes one terminated by the two-byte string terminator instead", () => {
    const stringTerminator = `${ESCAPE}${BACKSLASH}`;
    expect(withoutResidualEscapes(`${ESCAPE}]0;a title${stringTerminator}built`)).toBe("built");
  });

  it("removes a two-byte escape carrying an intermediate", () => {
    expect(withoutResidualEscapes(`p${ESCAPE}(Bq`)).toBe("pq");
  });

  it("removes a control sequence the styling parse did not consume", () => {
    expect(withoutResidualEscapes(`before${ESCAPE}[2Jafter`)).toBe("beforeafter");
  });

  it("removes a lone introducer at the end of a truncated body", () => {
    // A body is truncated at a codepoint boundary and not at a sequence boundary, so
    // the tail can be half a sequence — which is the same byte on the page as all of
    // it would have been.
    expect(withoutResidualEscapes(`built${ESCAPE}`)).toBe("built");
    expect(withoutResidualEscapes(`built${ESCAPE}]0;a title`)).toBe("built");
  });

  it("negative control: text with no escape comes back by identity", () => {
    // Without this the strip could be written as a copy that runs over every body,
    // which is a pass over the whole of every prose reply for nothing.
    const prose = "an ordinary reply";
    expect(withoutResidualEscapes(prose)).toBe(prose);
  });

  it("negative control: it takes no ordinary character with it", () => {
    // The bracket and the semicolon an OSC uses are ordinary text outside one, and a
    // strip written as a character filter would have eaten them everywhere.
    expect(withoutResidualEscapes("array[0]; then 0;more")).toBe("array[0]; then 0;more");
  });
});
