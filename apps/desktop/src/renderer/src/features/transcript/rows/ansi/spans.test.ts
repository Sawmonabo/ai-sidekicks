import { describe, expect, it } from "vitest";

import { AnsiSpanParser, ansiColorClassName, ansiSpanClassNames, type AnsiSpan } from "./spans.js";
import { TEXT_CONTRAST_FLOOR } from "#renderer/styles/tokens.js";
import { TOKEN_ALIASES } from "#renderer/styles/palette.js";
import { contrastRatio, oklchToSrgb } from "#shared/color.js";
import { COLOR_SCHEMES } from "#shared/color-scheme.js";
import { APPEARANCE_THEMES, THEME_PALETTES } from "#shared/theme/registry.js";
import { publishedTextOf, type PublishedText } from "../../reveal/published-text.js";
import { RevealTextRope } from "../../reveal/text-rope.js";

/** Built from their code points: a raw control byte in source is invisible in a diff. */
const ESCAPE = String.fromCodePoint(0x1b);
const BELL = String.fromCodePoint(0x07);

/** The spans a parser holds once it has read a text: those it settled so far, then its tail. */
class ReadSpans {
  readonly #parser = new AnsiSpanParser();
  #settled: AnsiSpan[] = [];

  public read(text: PublishedText): readonly AnsiSpan[] {
    const read = this.#parser.read(text, text.length);
    if (read.restarted) {
      this.#settled = [];
    }
    this.#settled.push(...read.settledSpans);
    return [...this.#settled, ...read.tailSpans];
  }
}

/** The spans one parse of the whole of `text` draws. */
function wholeParse(text: string): readonly AnsiSpan[] {
  return new ReadSpans().read(publishedTextOf(text));
}

/**
 * Each run's text, foreground and decorations, adjacent spans of one style joined: what a reader
 * sees of them, however a parse cut them.
 */
function drawnRuns(spans: readonly AnsiSpan[]): readonly (readonly unknown[])[] {
  const runs: { text: string; span: AnsiSpan }[] = [];
  for (const span of spans) {
    const last = runs.at(-1);
    if (
      last !== undefined &&
      ansiSpanClassNames(last.span).join() === ansiSpanClassNames(span).join()
    ) {
      last.text += span.text;
    } else {
      runs.push({ text: span.text, span });
    }
  }
  return runs.map((run) => [run.text, run.span.foreground, run.span.decorations]);
}

describe("parsing ANSI output", () => {
  it("keeps the text and drops the escape sequences", () => {
    const spans = wholeParse(`${ESCAPE}[31mfailed${ESCAPE}[39m`);
    expect(spans.map((span) => span.text).join("")).toBe("failed");
    expect(spans.map((span) => span.text).join("")).not.toContain(ESCAPE);
  });

  it("draws a 256-color or true-color code in the nearest of the sixteen names", () => {
    const spans = wholeParse(
      `${ESCAPE}[38;5;196mpalette red${ESCAPE}[39m ` +
        `${ESCAPE}[38;2;30;90;220mtrue blue${ESCAPE}[39m ` +
        `${ESCAPE}[38;5;244mpalette gray${ESCAPE}[39m ` +
        `${ESCAPE}[7;38;2;250;250;250;48;5;34mreversed${ESCAPE}[0m`,
    );
    const colored = spans.filter((span) => span.text.trim() !== "");
    expect(colored.map((span) => [span.text, span.foreground, span.background])).toEqual([
      ["palette red", "bright-red", undefined],
      ["true blue", "bright-blue", undefined],
      ["palette gray", "bright-black", undefined],
      // Reverse video keeps what the stream set on each channel, true colors included.
      ["reversed", "bright-white", "green"],
    ]);
  });

  it("draws a reversed badge as a block of its color with letters in the body's ground", () => {
    // Jest's `FAIL` badge, `chalk.reset.inverse.bold.red(" FAIL ")`: the stream sets red text and
    // no background, then reverses. A terminal swaps the two: a red block, the letters in its own
    // ground, never in the text color on the page.
    const spans = wholeParse(
      `${ESCAPE}[0m${ESCAPE}[7m${ESCAPE}[1m${ESCAPE}[31m FAIL ` +
        `${ESCAPE}[39m${ESCAPE}[22m${ESCAPE}[27m${ESCAPE}[0m src/run.test.ts`,
    );
    const badge = spans.find((span) => span.text === " FAIL ");
    expect(badge).toBeDefined();
    const classNames = ansiSpanClassNames(badge as AnsiSpan);
    expect(classNames).toContain(ansiColorClassName("bg", "red"));
    expect(classNames).toContain(ansiColorClassName("fg", "default-background"));
    // The letters read on the block in every theme and scheme: the body's ground on red.
    const letterRole = TOKEN_ALIASES["ansi-default-background"] as "surface-sunken";
    for (const theme of APPEARANCE_THEMES) {
      for (const scheme of COLOR_SCHEMES) {
        const colors = THEME_PALETTES[theme].colors;
        const ratio = contrastRatio(
          oklchToSrgb(colors[letterRole][scheme]),
          oklchToSrgb(colors["ansi-red"][scheme]),
        );
        expect(ratio, `${theme} ${scheme}`).toBeGreaterThanOrEqual(TEXT_CONTRAST_FLOOR);
      }
    }
  });

  it("draws text normal once its style is cleared, however often the style was set", () => {
    // A terminal holds a style as on or off: setting bold twice and clearing it once leaves it off.
    const spans = wholeParse(
      `${ESCAPE}[1m${ESCAPE}[1mbold ${ESCAPE}[22mnormal ` +
        `${ESCAPE}[3;3;23mupright ${ESCAPE}[4m${ESCAPE}[4m${ESCAPE}[24mplain`,
    );
    expect(spans.map((span) => [span.text, span.decorations])).toEqual([
      ["bold ", ["bold"]],
      ["normal ", []],
      ["upright ", []],
      ["plain", []],
    ]);
  });

  it("parses a growing output a part at a time into what one parse of the whole draws", () => {
    // Red opens before a boundary and closes after it, and growth steps stop inside an escape and
    // past a line end inside a run, where an OSC sequence crossing the end is stripped whole; the
    // style must carry across each boundary and no sequence may be split.
    const final =
      `plain ${ESCAPE}[31mred ${ESCAPE}[1mred bold${ESCAPE}[22m red\nagain ` +
      `${ESCAPE}]0;a\ntitle${BELL}still\n${ESCAPE}[39m plain end`;
    const rope = new RevealTextRope("lane-1");
    rope.append(final);
    const parser = new ReadSpans();
    const growthSteps = [
      final.indexOf(`${ESCAPE}[31m`) + 3,
      final.indexOf("bold"),
      final.indexOf("again"),
      final.indexOf("title"),
      final.indexOf("still"),
      final.indexOf(`${ESCAPE}[39m`) + 2,
      final.length,
    ];
    for (const revealedLength of growthSteps) {
      rope.advance(revealedLength - rope.length);
      const read = parser.read(rope);
      expect(drawnRuns(read)).toEqual(drawnRuns(wholeParse(rope.slice(0))));
      if (revealedLength === final.indexOf("bold")) {
        // The last run is parsed from the state the parsed part left: red, then bold on top.
        expect(drawnRuns(read)).toEqual([
          ["plain ", undefined, []],
          ["red ", "red", []],
          ["red ", "red", ["bold"]],
        ]);
      }
    }
    expect(drawnRuns(parser.read(rope))).toEqual([
      ["plain ", undefined, []],
      ["red ", "red", []],
      ["red bold", "red", ["bold"]],
      [" red\nagain still\n", "red", []],
      [" plain end", undefined, []],
    ]);

    // A rewrite of the `ESC [` the parsed part ends before joins its text to the run before it.
    const parsedLength = final.indexOf(`${ESCAPE}[39m`);
    rope.rebase(`${final.slice(0, parsedLength)} still red`, parsedLength);
    rope.advance(rope.pendingCharacterCount);
    expect(drawnRuns(parser.read(rope)).at(-1)).toEqual([
      " red\nagain still\n still red",
      "red",
      [],
    ]);

    // A rewrite below the parsed part draws the new text, not the old.
    const rewritten = `plain ${ESCAPE}[32mgreen${ESCAPE}[39m done`;
    rope.rebase(rewritten, 2);
    rope.advance(rope.pendingCharacterCount);
    const afterRewrite = parser.read(rope);
    expect(drawnRuns(afterRewrite)).toEqual(drawnRuns(wholeParse(rewritten)));
    expect(drawnRuns(afterRewrite)).toEqual([
      ["plain ", undefined, []],
      ["green", "green", []],
      [" done", undefined, []],
    ]);
  });
});
