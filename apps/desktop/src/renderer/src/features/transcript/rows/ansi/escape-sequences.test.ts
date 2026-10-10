// Sequences a real shell emits. `anser` consumes CSI but leaves OSC and two-byte escapes in the
// chunk it returns; DCS, SOS, PM and APC carry an arbitrary-length payload up to a terminator.

import { describe, expect, it } from "vitest";

import { publishedTextOf } from "../../reveal/published-text.js";
import { carriesAnsiEscapes, withoutResidualEscapes } from "./escape-sequences.js";

const ESCAPE = "\u001b";
const BACKSLASH = "\\";
const BELL = "\u0007";

const STRING_TERMINATOR = `${ESCAPE}${BACKSLASH}`;

const C1_STRING_TERMINATOR = "\u009c";

const STRING_CONTROLS = [
  { name: "DCS", introducer: "P", payload: "1$r0m" },
  { name: "SOS", introducer: "X", payload: "a start-of-string payload" },
  { name: "PM", introducer: "^", payload: "a privacy message" },
  { name: "APC", introducer: "_", payload: "a program command" },
] as const;

describe("whether a body is command output", () => {
  it("ordinary prose is not command output", () => {
    // Otherwise every body would read as ANSI.
    expect(
      carriesAnsiEscapes(publishedTextOf("an ordinary **reply**\nover two lines\twith a tab")),
    ).toBe(false);
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
    // A body is cut at a codepoint boundary, so the tail can be half a sequence.
    expect(withoutResidualEscapes(`built${ESCAPE}`)).toBe("built");
    expect(withoutResidualEscapes(`built${ESCAPE}]0;a title`)).toBe("built");
  });

  it("takes no ordinary character with it", () => {
    // The bracket and semicolon an OSC uses are ordinary text outside one.
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
      // A stream may close with either spelling.
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
      // A body is cut at a codepoint boundary, so the tail can be a control nobody closed.
      expect(withoutResidualEscapes(`built${ESCAPE}${introducer}${payload}`)).toBe("built");
      expect(withoutResidualEscapes(`built${ESCAPE}${introducer}`)).toBe("built");
    },
  );

  it("ends a control at an escape that is not the terminator, and reads on from it", () => {
    // The escape inside the control is read as the sequence it introduces.
    expect(withoutResidualEscapes(`a${ESCAPE}Ppayload${ESCAPE}[31mb`)).toBe("ab");
  });

  it("an unterminated control does not eat the whole remainder", () => {
    // The escape inside re-synchronizes the walk; the text after it stays.
    expect(withoutResidualEscapes(`a${ESCAPE}Ppayload${ESCAPE}(Bkept`)).toBe("akept");
  });

  it("the introducer bytes are ordinary text outside a sequence", () => {
    // `P`, `X`, `^` and `_` are ordinary characters outside a sequence.
    expect(withoutResidualEscapes("P X ^ _ and a path_name")).toBe("P X ^ _ and a path_name");
  });
});
