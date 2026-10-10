import { describe, expect, it } from "vitest";

import { AnsiSpanParser, ansiColorClassName, ansiSpanClassNames, type AnsiSpan } from "./spans.js";
import { TEXT_CONTRAST_FLOOR } from "#renderer/styles/tokens.js";
import { TOKEN_ALIASES } from "#renderer/styles/palette.js";
import { contrastRatio, oklchToSrgb } from "#shared/color.js";
import { COLOR_SCHEMES } from "#shared/color-scheme.js";
import { APPEARANCE_THEMES, THEME_PALETTES } from "#shared/theme/registry.js";
import { publishedTextOf } from "../../reveal/published-text.js";
import { RevealTextRope } from "../../reveal/text-rope.js";

/** Built from its code point: a raw escape in source is invisible in a diff. */
const ESCAPE = String.fromCodePoint(0x1b);

/** Each span's text, foreground and decorations: what a reader sees of it. */
function drawnRuns(spans: readonly AnsiSpan[]): readonly (readonly unknown[])[] {
  return spans.map((span) => [span.text, span.foreground, span.decorations]);
}

describe("parsing ANSI output", () => {
  it("keeps the text and drops the escape sequences", () => {
    const spans = new AnsiSpanParser().read(publishedTextOf(`${ESCAPE}[31mfailed${ESCAPE}[39m`));
    expect(spans.map((span) => span.text).join("")).toBe("failed");
    expect(spans.map((span) => span.text).join("")).not.toContain(ESCAPE);
  });

  it("draws a 256-color or true-color code in the nearest of the sixteen names", () => {
    const spans = new AnsiSpanParser().read(
      publishedTextOf(
        `${ESCAPE}[38;5;196mpalette red${ESCAPE}[39m ` +
          `${ESCAPE}[38;2;30;90;220mtrue blue${ESCAPE}[39m ` +
          `${ESCAPE}[38;5;244mpalette gray${ESCAPE}[39m ` +
          `${ESCAPE}[7;38;2;250;250;250;48;5;34mreversed${ESCAPE}[0m`,
      ),
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
    const spans = new AnsiSpanParser().read(
      publishedTextOf(
        `${ESCAPE}[0m${ESCAPE}[7m${ESCAPE}[1m${ESCAPE}[31m FAIL ` +
          `${ESCAPE}[39m${ESCAPE}[22m${ESCAPE}[27m${ESCAPE}[0m src/run.test.ts`,
      ),
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

  it("parses a growing output a part at a time into what one parse of the whole draws", () => {
    // Red opens before a boundary and closes after it, and growth steps stop inside an escape;
    // the style must carry across each boundary and no sequence may be split.
    const final =
      `plain ${ESCAPE}[31mred ${ESCAPE}[1mred bold${ESCAPE}[22m red again` +
      `${ESCAPE}[39m plain end`;
    const rope = new RevealTextRope("lane-1");
    rope.append(final);
    const parser = new AnsiSpanParser();
    const growthSteps = [
      final.indexOf(`${ESCAPE}[31m`) + 3,
      final.indexOf("bold"),
      final.indexOf(`${ESCAPE}[39m`) + 2,
      final.length,
    ];
    for (const revealedLength of growthSteps) {
      rope.advance(revealedLength - rope.length);
      const read = parser.read(rope);
      expect(read).toEqual(new AnsiSpanParser().read(publishedTextOf(rope.slice(0))));
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
      [" red again", "red", []],
      [" plain end", undefined, []],
    ]);

    // A rewrite of the `ESC [` the parsed part ends before joins its text to the run before it.
    const parsedLength = final.indexOf(`${ESCAPE}[39m`);
    rope.rebase(`${final.slice(0, parsedLength)} still red`, parsedLength);
    rope.advance(rope.pendingCharacterCount);
    expect(drawnRuns(parser.read(rope)).at(-1)).toEqual([" red again still red", "red", []]);

    // A rewrite below the parsed part draws the new text, not the old.
    const rewritten = `plain ${ESCAPE}[32mgreen${ESCAPE}[39m done`;
    rope.rebase(rewritten, 2);
    rope.advance(rope.pendingCharacterCount);
    const afterRewrite = parser.read(rope);
    expect(afterRewrite).toEqual(new AnsiSpanParser().read(publishedTextOf(rewritten)));
    expect(drawnRuns(afterRewrite)).toEqual([
      ["plain ", undefined, []],
      ["green", "green", []],
      [" done", undefined, []],
    ]);
  });
});
