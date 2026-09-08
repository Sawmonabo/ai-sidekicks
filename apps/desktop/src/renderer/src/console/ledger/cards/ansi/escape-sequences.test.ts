// What the span parse leaves behind, and what a body's own bytes say about its shape.
//
// Both claims are measured against the pinned `anser`: it consumes CSI sequences and
// leaves OSC and the two-byte escapes inside the chunk it hands back. Every case below
// is a sequence family a real shell emits, and the negative controls are the two ways
// the strip could be wrong — taking text with it, or firing on a body that has none.
//
// AND ONE FAMILY IS ITS OWN DESCRIBE, because it is the one the scan got wrong rather
// than merely the one it had not met: DCS, SOS, PM and APC carry a payload of arbitrary
// length and were read as two-byte escapes, so a terminal that sent one put the whole
// payload on the page as text up to the terminator nothing looked for.

import { describe, expect, it } from "vitest";

import { carriesAnsiEscapes, withoutResidualEscapes } from "./escape-sequences.js";

const ESCAPE = "\u001b";
const BACKSLASH = "\\";
const BELL = "\u0007";

/** The two-byte string terminator, spelled the way a stream sends it. */
const STRING_TERMINATOR = `${ESCAPE}${BACKSLASH}`;

/** The C1 string terminator — the same end, in one byte. */
const C1_STRING_TERMINATOR = "\u009c";

/** The four string controls, by the introducer that opens each one. */
const STRING_CONTROLS = [
  { name: "DCS", introducer: "P", payload: "1$r0m" },
  { name: "SOS", introducer: "X", payload: "a start-of-string payload" },
  { name: "PM", introducer: "^", payload: "a privacy message" },
  { name: "APC", introducer: "_", payload: "a program command" },
] as const;

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

describe("a string control, consumed through its terminator", () => {
  it.each(STRING_CONTROLS)(
    "removes a $name payload up to the two-byte string terminator",
    ({ introducer, payload }) => {
      expect(
        withoutResidualEscapes(`before${ESCAPE}${introducer}${payload}${STRING_TERMINATOR}after`),
      ).toBe("beforeafter");
    },
  );

  it.each(STRING_CONTROLS)(
    "removes a $name payload ended by the single-byte C1 terminator instead",
    ({ introducer, payload }) => {
      // A stream may close with either spelling, and the scan opens on ESC alone — so
      // accepting only the two-byte form would leave the payload of a correctly formed
      // sequence standing.
      expect(
        withoutResidualEscapes(
          `before${ESCAPE}${introducer}${payload}${C1_STRING_TERMINATOR}after`,
        ),
      ).toBe("beforeafter");
    },
  );

  it.each(STRING_CONTROLS)(
    "consumes an unterminated $name tail without reading past the body",
    ({ introducer, payload }) => {
      // A body is truncated at a codepoint boundary rather than at a sequence boundary,
      // so the tail can be a control nobody closed. It ends where the body does.
      expect(withoutResidualEscapes(`built${ESCAPE}${introducer}${payload}`)).toBe("built");
      expect(withoutResidualEscapes(`built${ESCAPE}${introducer}`)).toBe("built");
    },
  );

  it("ends a control at an escape that is not the terminator, and reads on from it", () => {
    // The payload of an unterminated control is not licence to swallow the rest of the
    // body: the escape inside it is handed back to the walk, read as the sequence it
    // introduces, and the text after THAT survives.
    expect(withoutResidualEscapes(`a${ESCAPE}Ppayload${ESCAPE}[31mb`)).toBe("ab");
  });

  it("negative control: an unterminated control does not eat the whole remainder", () => {
    // Without this the case above would pass over a scan that consumed to the end of the
    // body on every unterminated control, which loses the output a shell went on to
    // print. The escape inside re-synchronises the walk; the text after it stays.
    expect(withoutResidualEscapes(`a${ESCAPE}Ppayload${ESCAPE}(Bkept`)).toBe("akept");
  });

  it("negative control: the introducer bytes are ordinary text outside a sequence", () => {
    // `P`, `X`, `^` and `_` are letters and punctuation everywhere else, and a strip
    // written as a character filter would have taken them out of every body.
    expect(withoutResidualEscapes("P X ^ _ and a path_name")).toBe("P X ^ _ and a path_name");
  });
});
