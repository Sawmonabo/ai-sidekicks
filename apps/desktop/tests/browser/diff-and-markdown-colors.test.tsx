// A diff block's lines and a Markdown block's own syntax paint in the theme's tokens, in every
// theme and scheme, read off what Chromium computes: added lines in the green, removed lines in
// the red, hunk ranges dimmed, headings and inline code as names, emphasis as a keyword. Each
// colored span also differs from the block's plain text, so a rule that fell back to plain fails.

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HIGHLIGHT_SPAN_CLASSES, type HighlightSpanClass } from "@ai-sidekicks/contracts/highlight";

import { applyAppearance, installMeridianTokens } from "#renderer/app/token-installation.js";
import type {
  CodeSpanReader,
  CodeSpanRequest,
} from "#renderer/components/Markdown/highlight/code-span-reader.js";
import { CodeBlock } from "#renderer/components/Markdown/highlight/CodeBlock.js";
import { DEFAULT_APPEARANCE_RECORD } from "#shared/appearance.js";
import { COLOR_SCHEMES } from "#shared/color-scheme.js";
import { APPEARANCE_THEMES } from "#shared/theme/registry.js";
import { computedTokenColor } from "#test/helpers/token-color.js";

/** One colored stretch of a block: the text it covers and the class the daemon gives it. */
type ColoredText = readonly [text: string, spanClass: HighlightSpanClass];

const DIFF_SOURCE = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n";
const DIFF_COLORS: readonly ColoredText[] = [
  ["--- a/x", "deleted"],
  ["+++ b/x", "inserted"],
  ["@@ -1,2 +1,2 @@", "hunk"],
  ["-old", "deleted"],
  ["+new", "inserted"],
];

const MARKDOWN_SOURCE =
  "# Title\n\nSome *soft* and **firm** text, `code` and a [link](https://x.y).\n";
const MARKDOWN_COLORS: readonly ColoredText[] = [
  ["# Title", "heading"],
  ["*soft*", "emphasis"],
  ["**firm**", "emphasis"],
  ["`code`", "inline-code"],
  ["link", "string"],
];

/** The theme token each class paints in. */
const TOKEN_BY_CLASS: Readonly<Partial<Record<HighlightSpanClass, string>>> = {
  inserted: "ansi-green",
  deleted: "ansi-red",
  hunk: "text-faint",
  heading: "code-name",
  emphasis: "code-keyword",
  "inline-code": "code-name",
  string: "code-string",
};

const RENDERINGS = APPEARANCE_THEMES.flatMap((theme) =>
  COLOR_SCHEMES.map((scheme) => ({ theme, scheme })),
);

/** The packed spans the daemon sends for `colors` over `source`, each found by its text. */
function packSpans(source: string, colors: readonly ColoredText[]): Uint32Array {
  let searchFrom = 0;
  return Uint32Array.from(
    colors.flatMap(([text, spanClass]) => {
      const offset = source.indexOf(text, searchFrom);
      searchFrom = offset + text.length;
      return [offset, text.length, HIGHLIGHT_SPAN_CLASSES.indexOf(spanClass)];
    }),
  );
}

/** A reader already holding each block's spans, so a block paints on its first frame. */
function heldSpanReader(spansBySource: ReadonlyMap<string, Uint32Array>): CodeSpanReader {
  return {
    heldSpans: (request: CodeSpanRequest) => spansBySource.get(request.source),
    readSpans: () => Promise.reject(new Error("Every block's spans are already held.")),
  };
}

/** Each colored span of `block` whose computed color is not its class's token, or is plain. */
function findMispaintedSpans(block: Element, colors: readonly ColoredText[]): string[] {
  const plainColor = getComputedStyle(block.querySelector("code") ?? block).color;
  const spans = [...block.querySelectorAll("code span")];
  expect(spans.map((span) => span.textContent)).toStrictEqual(colors.map(([text]) => text));
  return colors.flatMap(([text, spanClass], index) => {
    const painted = getComputedStyle(spans[index] ?? block).color;
    const tokenName = TOKEN_BY_CLASS[spanClass] ?? "";
    const expected = computedTokenColor(tokenName);
    return painted === expected && painted !== plainColor
      ? []
      : [`${text} (${spanClass}) paints ${painted}, not ${tokenName} ${expected}`];
  });
}

beforeEach(() => {
  installMeridianTokens(document);
});

afterEach(() => {
  cleanup();
  applyAppearance(document, DEFAULT_APPEARANCE_RECORD);
});

describe.each(RENDERINGS)("a diff and a Markdown block in $theme $scheme", (rendering) => {
  it("paints each colored line and mark in its class's token", () => {
    applyAppearance(document, { ...DEFAULT_APPEARANCE_RECORD, ...rendering });
    const reader = heldSpanReader(
      new Map([
        [DIFF_SOURCE, packSpans(DIFF_SOURCE, DIFF_COLORS)],
        [MARKDOWN_SOURCE, packSpans(MARKDOWN_SOURCE, MARKDOWN_COLORS)],
      ]),
    );
    const { container } = render(
      <>
        <CodeBlock
          source={DIFF_SOURCE}
          infoString="diff"
          isSettled
          codeSpanReader={reader}
          renderCopy={undefined}
        />
        <CodeBlock
          source={MARKDOWN_SOURCE}
          infoString="md"
          isSettled
          codeSpanReader={reader}
          renderCopy={undefined}
        />
      </>,
    );
    const [diffBlock, markdownBlock] = container.querySelectorAll(".meridian-code-block");
    expect(findMispaintedSpans(diffBlock ?? container, DIFF_COLORS)).toStrictEqual([]);
    expect(findMispaintedSpans(markdownBlock ?? container, MARKDOWN_COLORS)).toStrictEqual([]);
  });
});
