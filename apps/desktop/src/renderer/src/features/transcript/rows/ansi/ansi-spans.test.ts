import { describe, expect, it } from "vitest";

import {
  ANSI_COLOR_NAMES,
  ANSI_DECORATIONS,
  ansiSpanClassNames,
  isReproducedAnsiDecoration,
  parseAnsiSpans,
} from "./ansi-spans.js";

/** Built from its code point: a raw escape in source is invisible in a diff. */
const ESCAPE = String.fromCodePoint(0x1b);

/** One styled run per repetition, each with content, so a run count is a span count. */
function styledRuns(runCount: number): string {
  return `${ESCAPE}[31ma${ESCAPE}[39m`.repeat(runCount);
}

describe("parsing ANSI output", () => {
  it("keeps the text and drops the escape sequences", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[31mfailed${ESCAPE}[39m`);
    expect(spans.map((span) => span.text).join("")).toBe("failed");
    expect(spans.map((span) => span.text).join("")).not.toContain(ESCAPE);
  });

  it("names the color rather than resolving it", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[31mfailed`);
    expect(spans[0]?.foreground).toBe("red");
    expect(ANSI_COLOR_NAMES).toContain("red");
  });

  it("renders a color the console does not reproduce in the inherited foreground", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[38;5;208mamber-ish`);
    expect(spans[0]?.text).toBe("amber-ish");
    expect(spans[0]?.foreground).toBeUndefined();
  });

  it("reads reverse video from the flag anser actually publishes", () => {
    // The library strips `reverse` from `decorations` and reports `isInverted`, which its
    // declaration omits; this pins both halves.
    const { spans } = parseAnsiSpans(`${ESCAPE}[7mswapped`);
    expect(spans[0]?.reversed).toBe(true);
    expect(spans[0]?.decorations).toStrictEqual([]);
  });

  it("keeps the stream's own two colors under reverse video, unswapped", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[31m${ESCAPE}[42m${ESCAPE}[7mswapped`);
    expect(spans[0]?.foreground).toBe("red");
    expect(spans[0]?.background).toBe("green");
    expect(spans[0]?.reversed).toBe(true);
  });

  it("undoes the library's own default substitution, leaving the unset channel unset", () => {
    // Anser fills a missing channel with white/black before it swaps.
    const bare = parseAnsiSpans(`${ESCAPE}[7mbare`);
    expect(bare.spans[0]?.foreground).toBeUndefined();
    expect(bare.spans[0]?.background).toBeUndefined();

    const foregroundOnly = parseAnsiSpans(`${ESCAPE}[31m${ESCAPE}[7mhalf`);
    expect(foregroundOnly.spans[0]?.foreground).toBe("red");
    expect(foregroundOnly.spans[0]?.background).toBeUndefined();
  });

  it("clears reverse video on the sequence that turns it off", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[7mon${ESCAPE}[27moff`);
    expect(spans[0]?.text).toBe("on");
    expect(spans[0]?.reversed).toBe(true);
    expect(spans[1]?.text).toBe("off");
    expect(spans[1]?.reversed).toBe(false);
  });

  it("negative control: an unreversed run carries no reverse state", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[31mfailed`);
    expect(spans[0]?.reversed).toBe(false);
  });

  it("reproduces bold and underline", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[1m${ESCAPE}[4mloud`);
    expect(spans[0]?.decorations).toContain("bold");
    expect(spans[0]?.decorations).toContain("underline");
  });

  it("negative control: blink and conceal are NOT reproduced", () => {
    const { spans } = parseAnsiSpans(`${ESCAPE}[5m${ESCAPE}[8msecret`);
    expect(spans.map((span) => span.text).join("")).toBe("secret");
    expect(spans[0]?.decorations).toStrictEqual([]);
    expect(isReproducedAnsiDecoration("blink")).toBe(false);
    expect(isReproducedAnsiDecoration("hidden")).toBe(false);
    expect(ANSI_DECORATIONS).not.toContain("blink");
  });

  it("bounds what it renders and says how much it left out", () => {
    const { spans, elidedSpanCount } = parseAnsiSpans(styledRuns(ANSI_SPAN_RENDER_CAP + 40));
    expect(spans.length).toBe(ANSI_SPAN_RENDER_CAP);
    // The exact figure: the card prints it, and the entry total would also be positive.
    expect(elidedSpanCount).toBe(40);
  });

  it("takes the cap from its caller, so a fold can be lifted for one block", () => {
    // `AnsiOutput` re-parses the same source under a wider cap when the reader asks for the
    // rest.
    const source = styledRuns(10);
    const folded = parseAnsiSpans(source, 4);
    expect(folded.spans).toHaveLength(4);
    expect(folded.elidedSpanCount).toBe(6);

    const lifted = parseAnsiSpans(source, folded.spans.length + folded.elidedSpanCount);
    expect(lifted.spans).toHaveLength(10);
    expect(lifted.elidedSpanCount).toBe(0);
  });

  it("negative control: a cap at the run count elides nothing at its own boundary", () => {
    const { spans, elidedSpanCount } = parseAnsiSpans(styledRuns(4), 4);
    expect(spans).toHaveLength(4);
    expect(elidedSpanCount).toBe(0);
  });

  it("negative control: output inside the bound elides nothing", () => {
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
      reversed: false,
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
        reversed: false,
        decorations: [],
      }),
    ).toStrictEqual([]);
  });

  it("paints a bare reversed run in the console's own default pair, swapped", () => {
    expect(
      ansiSpanClassNames({
        text: "x",
        foreground: undefined,
        background: undefined,
        reversed: true,
        decorations: [],
      }),
    ).toStrictEqual([
      "meridian-ansi__fg--default-background",
      "meridian-ansi__bg--default-foreground",
    ]);
  });

  it("swaps one explicit color against the console's default for the other channel", () => {
    expect(
      ansiSpanClassNames({
        text: "x",
        foreground: "red",
        background: undefined,
        reversed: true,
        decorations: [],
      }),
    ).toStrictEqual(["meridian-ansi__fg--default-background", "meridian-ansi__bg--red"]);
    expect(
      ansiSpanClassNames({
        text: "x",
        foreground: undefined,
        background: "green",
        reversed: true,
        decorations: [],
      }),
    ).toStrictEqual(["meridian-ansi__fg--green", "meridian-ansi__bg--default-foreground"]);
  });

  it("swaps two explicit colors and keeps every decoration", () => {
    expect(
      ansiSpanClassNames({
        text: "x",
        foreground: "red",
        background: "green",
        reversed: true,
        decorations: ["bold"],
      }),
    ).toStrictEqual(["meridian-ansi__fg--green", "meridian-ansi__bg--red", "meridian-ansi--bold"]);
  });

  it("negative control: swapping two undefined channels would name nothing", () => {
    // With both channels unset, a swap that carried the two `undefined`s named no classes.
    const bare = ansiSpanClassNames({
      text: "x",
      foreground: undefined,
      background: undefined,
      reversed: true,
      decorations: [],
    });
    expect(bare).not.toStrictEqual([]);
    expect(bare).toHaveLength(2);
  });

  it("negative control: an unreversed span with both colors does not swap them", () => {
    expect(
      ansiSpanClassNames({
        text: "x",
        foreground: "red",
        background: "green",
        reversed: false,
        decorations: [],
      }),
    ).toStrictEqual(["meridian-ansi__fg--red", "meridian-ansi__bg--green"]);
  });
});
import { ANSI_SPAN_RENDER_CAP } from "../../cards/card-caps.js";
