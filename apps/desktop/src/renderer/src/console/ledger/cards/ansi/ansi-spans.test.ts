// ANSI as data — and the two decorations this console deliberately does not reproduce.

import { describe, expect, it } from "vitest";

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

/**
 * One styled run per repetition, so a fixture's run count is its repetition count.
 *
 * Every run carries content, which is what makes the elision figures below exact: anser
 * runs with `remove_empty`, so the entry list and the span list are the same population
 * and a count taken over either agrees — the parse counts over the SPANS' own walk so
 * that agreement is a property of this module rather than of an option set elsewhere.
 */
function styledRuns(runCount: number): string {
  return `${ESCAPE}[31ma${ESCAPE}[39m`.repeat(runCount);
}

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

  it("reads reverse video from the flag anser actually publishes", () => {
    // The library strips `reverse` from `decorations` and reports the state as
    // `isInverted`, a member its shipped declaration omits. This pins both halves: a
    // release that stopped setting the flag, or started leaving the decoration in place,
    // fails here rather than silently rendering every reversed run unreversed.
    const { spans } = parseAnsiSpans(`${ESCAPE}[7mswapped`);
    expect(spans[0]?.reversed).toBe(true);
    expect(spans[0]?.decorations).toStrictEqual([]);
  });

  it("keeps the stream's own two colours under reverse video, unswapped", () => {
    // The span reports what the STREAM said; the swap is a render-time relation between
    // the two channels, and lives with the class names.
    const { spans } = parseAnsiSpans(`${ESCAPE}[31m${ESCAPE}[42m${ESCAPE}[7mswapped`);
    expect(spans[0]?.foreground).toBe("red");
    expect(spans[0]?.background).toBe("green");
    expect(spans[0]?.reversed).toBe(true);
  });

  it("undoes the library's own default substitution, leaving the unset channel unset", () => {
    // Anser fills a missing channel with white/black before it swaps. Rendered, that pair
    // is muted grey on faint grey in this console — a substitution that reverses nothing.
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
    // Without this, a parser that reported every run reversed would pass every assertion
    // above, and every plain line of build output would render inverted.
    const { spans } = parseAnsiSpans(`${ESCAPE}[31mfailed`);
    expect(spans[0]?.reversed).toBe(false);
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
    const { spans, elidedSpanCount } = parseAnsiSpans(styledRuns(ANSI_SPAN_RENDER_CAP + 40));
    expect(spans.length).toBe(ANSI_SPAN_RENDER_CAP);
    // The exact figure, not merely a positive one: the count is what the card puts on
    // screen, and a mapper that reported the entry total rather than the withheld runs
    // would satisfy "greater than zero" while telling the reader the wrong number.
    expect(elidedSpanCount).toBe(40);
  });

  it("takes the cap from its caller, so a fold can be lifted for one block", () => {
    // `AnsiOutput` re-parses the same source under a wider cap when the reader asks for
    // the rest. Without a cap parameter the tail of a colour-heavy command is reachable
    // by nothing, because reopening the card re-parses exactly the same capped sequence.
    const source = styledRuns(10);
    const folded = parseAnsiSpans(source, 4);
    expect(folded.spans).toHaveLength(4);
    expect(folded.elidedSpanCount).toBe(6);

    const lifted = parseAnsiSpans(source, folded.spans.length + folded.elidedSpanCount);
    expect(lifted.spans).toHaveLength(10);
    expect(lifted.elidedSpanCount).toBe(0);
  });

  it("negative control: a cap at the run count elides nothing at its own boundary", () => {
    // Without this, an off-by-one that withheld the last admitted run would still report
    // a plausible-looking figure in the two assertions above.
    const { spans, elidedSpanCount } = parseAnsiSpans(styledRuns(4), 4);
    expect(spans).toHaveLength(4);
    expect(elidedSpanCount).toBe(0);
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
    // `ESC[7m` on its own sets neither colour, so both ends of the swap are the console's
    // defaults: the body's background becomes the text colour and its foreground the fill.
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

  it("swaps one explicit colour against the console's default for the other channel", () => {
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

  it("swaps two explicit colours and keeps every decoration", () => {
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
    // The defect this replaced: with both channels unset, a swap that carried the two
    // `undefined`s across produced no classes at all and the run rendered unreversed.
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

  it("negative control: an unreversed span with both colours does not swap them", () => {
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
import { ANSI_SPAN_RENDER_CAP } from "../../../core/index.js";
