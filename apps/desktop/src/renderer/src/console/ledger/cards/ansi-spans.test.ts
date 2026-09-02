// ANSI as data — and the two decorations this console deliberately does not reproduce.

import { describe, expect, it } from "vitest";

import { ANSI_SPAN_RENDER_CAP } from "./card-bounds.js";
import {
  ANSI_COLOR_NAMES,
  ANSI_DECORATIONS,
  ansiSpanClassNames,
  isReproducedAnsiDecoration,
  parseAnsiSpans,
} from "./ansi-spans.js";

/**
 * The control character every sequence below starts with.
 *
 * Built from its code point rather than typed as a literal: a raw escape in source is
 * invisible in a diff and in a review, and a test whose fixture cannot be read is a test
 * whose failure cannot be explained.
 */
const ESCAPE = String.fromCodePoint(0x1b);

describe("parsing ANSI output", () => {
  it("keeps the text and drops the escape sequences", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[31mfailed${ESCAPE}[39m`);
    expect(spans.map((span) => span.text).join("")).toBe("failed");
    expect(spans.map((span) => span.text).join("")).not.toContain(ESCAPE);
  });

  it("names the colour rather than resolving it", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[31mfailed`);
    expect(spans[0]?.foreground).toBe("red");
    expect(ANSI_COLOR_NAMES).toContain("red");
  });

  it("renders a colour the console does not reproduce in the inherited foreground", () => {
    // A 256-colour or true-colour run carries the tool's own palette, which has no
    // honest mapping onto this console's. It reads as plain text rather than as a
    // nearest-neighbour guess.
    const { spans } = parseAnsiSpans(`${ESCAPE}[38;5;208mamber-ish`);
    expect(spans[0]?.text).toBe("amber-ish");
    expect(spans[0]?.foreground).toBeUndefined();
  });

  it("swaps the two colours for reverse video", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[31m${ESCAPE}[42m${ESCAPE}[7mswapped`);
    expect(spans[0]?.foreground).toBe("green");
    expect(spans[0]?.background).toBe("red");
  });

  it("reproduces bold and underline", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[1m${ESCAPE}[4mloud`);
    expect(spans[0]?.decorations).toContain("bold");
    expect(spans[0]?.decorations).toContain("underline");
  });

  it("negative control: blink and conceal are NOT reproduced", () => {
    // Both absences are decisions. Blink would hand a subprocess the surface's motion
    // budget; conceal would let a tool hide bytes it printed. The text survives both.
    const { spans } = parseAnsiSpans(`${ESCAPE}[5m${ESCAPE}[8msecret`);
    expect(spans.map((span) => span.text).join("")).toBe("secret");
    expect(spans[0]?.decorations).toStrictEqual([]);
    expect(isReproducedAnsiDecoration("blink")).toBe(false);
    expect(isReproducedAnsiDecoration("hidden")).toBe(false);
    expect(ANSI_DECORATIONS).not.toContain("blink");
  });

  it("bounds what it renders and says how much it left out", () => {
    const oversized = Array.from(
      { length: ANSI_SPAN_RENDER_CAP + 40 },
      (_unused, index) => `${ESCAPE}[3${String(index % 7)}mx`,
    ).join("");
    const { spans, elidedSpanCount } = parseAnsiSpans(oversized);
    expect(spans.length).toBe(ANSI_SPAN_RENDER_CAP);
    expect(elidedSpanCount).toBeGreaterThan(0);
  });

  it("negative control: output inside the bound elides nothing", () => {
    // Without this, a mapper that always reported an elision would pass the case above.
    const { spans, elidedSpanCount } = parseAnsiSpans("plain output");
    expect(spans).toHaveLength(1);
    expect(elidedSpanCount).toBe(0);
  });
});

describe("the class names one span carries", () => {
  it("names a foreground, a background, and each decoration", () => {
    const names = ansiSpanClassNames({
      text: "x",
      foreground: "red",
      background: "bright-blue",
      decorations: ["bold"],
    });
    expect(names).toStrictEqual([
      "meridian-ansi__fg--red",
      "meridian-ansi__bg--bright-blue",
      "meridian-ansi--bold",
    ]);
  });

  it("negative control: an unstyled span carries no classes at all", () => {
    expect(
      ansiSpanClassNames({
        text: "x",
        foreground: undefined,
        background: undefined,
        decorations: [],
      }),
    ).toStrictEqual([]);
  });
});
