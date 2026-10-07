// The tail parser against the parse it stands in for: every prefix a stream can publish, at
// several chunk sizes, must parse to the same tree a whole parse gives, positions included.

import { describe, expect, it, vi } from "vitest";

import * as markdownParse from "#renderer/components/Markdown/parse.js";
import { VolatileTailParser } from "./volatile-tail.js";

vi.mock("#renderer/components/Markdown/parse.js", async (importOriginal) => {
  const actual = await importOriginal<typeof markdownParse>();
  return { ...actual, parseAgainstDefinitions: vi.fn(actual.parseAgainstDefinitions) };
});

const { footnoteDefinitionPreamble, mendVolatileTail } = markdownParse;
const wholeParses = vi.mocked(markdownParse.parseAgainstDefinitions);
const { parseAgainstDefinitions: parseWhole } = await vi.importActual<typeof markdownParse>(
  "#renderer/components/Markdown/parse.js",
);

/** Tails that reach back into earlier characters when a later one arrives. */
const TRICKY_TAILS: readonly string[] = [
  "The **daemon** holds one *control lease*, and a sec**ond** client waits; un_der_score and " +
    "snake_case stay literal. foo * bar, then *an emphasis that never closes and ~~a strike",
  "Intro paragraph.\n\n```ts\nconst a = 1;\n// ``` is not a closer here\n``\nlet b = `x`;\n```\n\n" +
    "After the fence, more words.\n\n~~~\ninside tilde\n```\nstill inside\n~~~\ndone\n\n" +
    "  ```\nan indented fence\n    keeps two of these spaces\n  ```\n\n    indented code\n    block\n\n" +
    "```\nwindows line endings\r\nin a fence\rand an old mac one",
  "- first item with text\n- second **bold** item\n  continued line here\n1. ordered one\n" +
    "2) other delimiter\n\n- [ ] task item\n- [x] done item\n\nStep 1 then 2. Not a list 3",
  "| Name | Value |\n| --- | :-: |\n| alpha | 1 |\n| beta | two words here |\n\nAfter table",
  "See [the docs](https://example.com/path) and www.example.com. Also <https://x.y> plus " +
    "foo@bar.com and [ref][1] and [lone] text.\n\n[1]: https://example.com\n\n[foo]: /url text\n\n" +
    '[bar]: /url "a title"\n\nUse [bar] here.',
  "It cost $5 and $10 today. $$x^2$$ inline, then:\n\n```math\na^2 + b^2\n```\n\nAnd $$ block",
  "Cite one[^1] and two[^note].\n\n[^1]: The first note.\n[^note]: The second, **bold** one",
  "# Title here\n\nSetext Heading\n===\n\nAnother one\n---\n\n## Closing hashes ##\n\nend #",
  "> quoted text with *emphasis*\n> second line\n>\n> - list in quote\n\nplain words follow",
  "AT&amp;T and &copy; 2024, a \\*literal\\* star, and a back\\slash. Hard break  \nnext line\\\n" +
    "last words",
  "Visit www.example.com. Or https://example.com/a(b)c). Done with links: http://x.y/z.",
  "Café — “quoted” text… and naïve façade ’tis, (parenthetical) remark; done?",
  '<div>\nblock html\n</div>\n\ninline <span class="x">html</span> here <b>bold and more',
  "1\n\n- -\n\n* * *\n\n10. ten items\n\n> 1 quoted number\n\ntrailing text   ",
];

/** Chunk sizes from a character at a time to a frame's full budget for one lane. */
const CHUNK_SIZES: readonly number[] = [1, 7, 61];

/** Every prefix a stream publishing `tail` in `chunkSize` steps shows, in order. */
function streamedPrefixes(tail: string, chunkSize: number): readonly string[] {
  const prefixes: string[] = [];
  for (let end = chunkSize; end < tail.length + chunkSize; end += chunkSize) {
    prefixes.push(tail.slice(0, Math.min(end, tail.length)));
  }
  return prefixes;
}

describe("a streaming tail parsed frame after frame", () => {
  it.each([
    { against: "no definitions", preamble: "" },
    {
      against: "the body's definitions",
      preamble: footnoteDefinitionPreamble(new Set(["1", "elsewhere"])),
    },
  ])("parses every published prefix as a whole parse would, against $against", ({ preamble }) => {
    // Each prefix's whole parse once: the chunk sizes publish many of the same prefixes.
    const wholeParseByPrefix = new Map<string, ReturnType<typeof parseWhole>>();
    for (const tail of TRICKY_TAILS) {
      for (const chunkSize of CHUNK_SIZES) {
        const parser = new VolatileTailParser();
        for (const prefix of streamedPrefixes(tail, chunkSize)) {
          const wholeParse =
            wholeParseByPrefix.get(prefix) ?? parseWhole(mendVolatileTail(prefix), preamble);
          wholeParseByPrefix.set(prefix, wholeParse);
          expect(
            parser.parse(prefix, preamble),
            `${JSON.stringify(prefix)} in chunks of ${String(chunkSize)}`,
          ).toStrictEqual(wholeParse);
        }
      }
    }
  });

  it("parses against the body's definitions as they change, never extending an older parse", () => {
    // A definition settling elsewhere in the body changes what the tail's reference means.
    const parser = new VolatileTailParser();
    parser.parse("The tail cites[^1] a note and", "");
    const preamble = footnoteDefinitionPreamble(new Set(["1"]));
    const prefix = "The tail cites[^1] a note and more";
    expect(parser.parse(prefix, preamble)).toStrictEqual(
      parseWhole(mendVolatileTail(prefix), preamble),
    );
  });

  it("parses most frames of prose, open emphasis and an open fence without a whole parse", () => {
    // The point of the parser: a frame that appends words or code lines costs its append.
    const prose =
      "The daemon holds one control lease per shell, so a second client sees the lease and " +
      "waits for it; retry is bounded by the cap, and the reader keeps their place as it grows.";
    const fence = "```ts\n" + "const value = compute(input, { cap: 4096 });\n".repeat(12);
    const openStrong = `Note: **${prose}`;
    for (const tail of [prose, fence, openStrong]) {
      const parser = new VolatileTailParser();
      const frames = streamedPrefixes(tail, 7);
      wholeParses.mockClear();
      for (const prefix of frames) {
        parser.parse(prefix, "");
      }
      expect(wholeParses.mock.calls.length).toBeLessThan(frames.length / 4);
    }
  });
});
