// Sequences a real shell emits. `anser` consumes CSI but leaves OSC and two-byte escapes in the
// chunk it returns; DCS, SOS, PM and APC carry an arbitrary-length payload up to a terminator.

import { describe, expect, it } from "vitest";

import { publishedTextOf } from "../../reveal/published-text.js";
import { RevealTextRope } from "../../reveal/text-rope.js";
import {
  carriesAnsiEscapes,
  EscapeSequenceStripper,
  StrippedText,
  withoutResidualEscapes,
} from "./escape-sequences.js";

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

describe("a text stripped a chunk at a time", () => {
  // One sequence of each kind and terminator, each followed by the one letter kept after it.
  const corpus = [
    `a${ESCAPE}[1;31mb`,
    `${ESCAPE}]0;a title${BELL}c`,
    `${ESCAPE}]8;;file:///x${STRING_TERMINATOR}d`,
    `${ESCAPE}P1$r0m${C1_STRING_TERMINATOR}e`,
    `${ESCAPE}Xa payload${STRING_TERMINATOR}f`,
    `${ESCAPE}^a payload${ESCAPE}[0mg`,
    `${ESCAPE}_a command${STRING_TERMINATOR}h`,
    `${ESCAPE}(Bi`,
    `${ESCAPE}#8j`,
    `${ESCAPE}7k`,
    `${ESCAPE}${ESCAPE}l`,
    `${ESCAPE}[2 qm`,
    `n${ESCAPE}`,
  ].join("");
  const kept = "abcdefghijklmn";

  /** `chunks` stripped one after another by one stripper, the runs it keeps joined. */
  function strippedInChunks(chunks: readonly string[]): string {
    const stripper = new EscapeSequenceStripper();
    return chunks.flatMap((chunk) => stripper.strip(chunk)).join("");
  }

  it("keeps what a whole-text strip keeps, wherever the text is cut", () => {
    expect(withoutResidualEscapes(corpus)).toBe(kept);
    for (let cutAt = 0; cutAt <= corpus.length; cutAt += 1) {
      expect(
        strippedInChunks([corpus.slice(0, cutAt), corpus.slice(cutAt)]),
        `cut at ${String(cutAt)}`,
      ).toBe(kept);
    }
    expect(strippedInChunks([...corpus])).toBe(kept);

    // A body growing a character at a time, read through one `StrippedText`, holds at each step
    // what a strip of its text so far keeps; a rewrite below what was read strips from the start.
    const rope = new RevealTextRope("lane");
    rope.append(corpus);
    const stripped = new StrippedText("body");
    for (let grownTo = 1; grownTo <= corpus.length; grownTo += 1) {
      rope.advance(1);
      expect(stripped.read(rope).slice(0), `grown to ${String(grownTo)}`).toBe(
        withoutResidualEscapes(corpus.slice(0, grownTo)),
      );
    }
    rope.rebase(`x${ESCAPE}[0my`, 0);
    rope.advance(rope.pendingCharacterCount);
    expect(stripped.read(rope).slice(0)).toBe("xy");
  });
});
