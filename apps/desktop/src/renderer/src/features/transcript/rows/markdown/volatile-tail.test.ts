// The tail parser against the parse it stands in for: every prefix a stream can publish, at
// several chunk sizes, must show the same tree a whole parse gives, positions included, and read
// as micromark, the reference GFM reader, reads it. Positions are left out of that second
// comparison because micromark starts a task item's paragraph at its checkbox and the parser
// after it, which nothing drawn reads. While a whole parse is on its way, or a parser ended for
// idleness loads again, the tree on screen stays.

import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { describe, expect, it, vi } from "vitest";

import { parseTree } from "#renderer/components/Markdown/parse/trees.test-support.js";
import { definitionPreambleOf } from "#renderer/components/Markdown/parse/definition-preamble.js";
import { appPageParser } from "#renderer/components/Markdown/parse/page-parser.js";
import { MarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { InThreadMarkdownWorkers } from "#renderer/components/Markdown/worker/connection.test-support.js";
import {
  MARKDOWN_WORKER_IDLE_STOP_MS,
  MarkdownWorkerConnection,
} from "#renderer/components/Markdown/worker/connection.js";
import { appTextCompression } from "#renderer/lib/text/compression.js";
import { mendVolatileTail, VolatileTailParser, type VolatileTailView } from "./volatile-tail.js";

/** A tail parser on its own trees, and the stand-in workers those trees parse with. */
function tailParser(): {
  readonly parser: VolatileTailParser;
  readonly workers: InThreadMarkdownWorkers;
} {
  const { trees, workers } = standInTrees();
  return { parser: new VolatileTailParser(trees), workers };
}

/** Trees of their own, parsed by stand-in workers. */
function standInTrees(): {
  readonly trees: MarkdownTrees;
  readonly workers: InThreadMarkdownWorkers;
} {
  const workers = new InThreadMarkdownWorkers();
  return {
    trees: new MarkdownTrees(
      new MarkdownWorkerConnection(workers.start, window, appPageParser, appTextCompression),
    ),
    workers,
  };
}

/** The tree the tail shows after `prefix` arrives, and the tail it says that tree answers. */
function shownAfter(
  parser: VolatileTailParser,
  prefix: string,
  preamble: string,
): Extract<VolatileTailView, { readonly status: "parsed" }> | undefined {
  parser.update(prefix, preamble);
  const view = parser.read();
  return view?.status === "parsed" ? view : undefined;
}

/**
 * `mended` as micromark reads it against `preamble`, with GFM as the app had it (a single tilde
 * never strikes through), less the preamble's nodes; positions are dropped.
 */
function micromarkTreeOf(mended: string, preamble: string): unknown {
  const root = fromMarkdown(preamble + mended, {
    extensions: [gfm({ singleTilde: false })],
    mdastExtensions: [gfmFromMarkdown()],
  });
  return withoutPositions({
    ...root,
    children: root.children.filter(
      (child) => (child.position?.start.offset ?? 0) >= preamble.length,
    ),
  });
}

function withoutPositions(tree: Root): unknown {
  return JSON.parse(
    JSON.stringify(tree, (key, value: unknown) => (key === "position" ? undefined : value)),
  );
}

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
  // A task item whose text opens on emphasis, code or a link starts its paragraph after the
  // checkbox, where a link definition's bracket would sit.
  "- [x] *done* item and its words\n- [ ] `code` first then words\n- [ ] [a link](u) then " +
    "words\n- [x]\n  next line words\n- [ ] [ref]: /not-a-definition words",
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

/** Each tail against no definitions and against the body's, one case each. */
const TAIL_CASES = TRICKY_TAILS.flatMap((tail) =>
  [
    { against: "no definitions", preamble: "" },
    {
      against: "the body's definitions",
      preamble: definitionPreambleOf(new Set(["1", "elsewhere"]), []),
    },
  ].map((definitions) => ({ ...definitions, tail, opening: tail.slice(0, 24) })),
);

describe("a streaming tail parsed frame after frame", () => {
  it.each(TAIL_CASES)(
    "shows every published prefix of $opening as a whole parse and micromark would, against $against",
    async ({ preamble, tail }) => {
      // Each prefix's whole parse once: the chunk sizes publish many of the same prefixes.
      const wholeParseByPrefix = new Map<string, Root>();
      for (const chunkSize of CHUNK_SIZES) {
        const { parser } = tailParser();
        for (const prefix of streamedPrefixes(tail, chunkSize)) {
          const label = `${JSON.stringify(prefix)} in chunks of ${String(chunkSize)}`;
          const mended = mendVolatileTail(prefix);
          let wholeParse = wholeParseByPrefix.get(prefix);
          if (wholeParse === undefined) {
            wholeParse = await parseTree(mended, preamble);
            wholeParseByPrefix.set(prefix, wholeParse);
            // Formulas are read as no micromark extension reads them; their trees are checked
            // against the trees they must make where the parse is.
            if (!mended.includes("$")) {
              expect(withoutPositions(wholeParse), label).toStrictEqual(
                micromarkTreeOf(mended, preamble),
              );
            }
          }
          expect(shownAfter(parser, prefix, preamble), label).toStrictEqual({
            status: "parsed",
            root: wholeParse,
            tailSource: prefix,
            definitionPreamble: preamble,
            settledBlockEnds: expect.any(Array),
          });
        }
      }
    },
  );

  it("parses against the body's definitions as they change, never extending an older parse", async () => {
    // A definition settling elsewhere in the body changes what the tail's reference means.
    const { parser } = tailParser();
    parser.update("The tail cites[^1] a note and", "");
    const preamble = definitionPreambleOf(new Set(["1"]), []);
    const prefix = "The tail cites[^1] a note and more";
    expect(shownAfter(parser, prefix, preamble)?.root).toStrictEqual(
      await parseTree(mendVolatileTail(prefix), preamble),
    );
  });

  it("keeps the newest tail's tree when an older ask lands after it", async () => {
    // The definitions change and change back: the ask for the middle ones lands last.
    const { parser, workers } = tailParser();
    const text = "The tail cites[^1] a note";
    const preamble = definitionPreambleOf(new Set(["1"]), []);
    parser.update(text, preamble);
    workers.latest().hold();
    parser.update(text, "");
    parser.update(text, preamble);
    workers.latest().release([0]);
    expect(parser.read()).toStrictEqual({
      status: "parsed",
      root: await parseTree(mendVolatileTail(text), preamble),
      tailSource: text,
      definitionPreamble: preamble,
      settledBlockEnds: [],
    });
  });

  it("shows at once the tree another parser of the same tail shows, grown by an append", () => {
    // A row mounted again starts a parser of a tail its preparation already shows.
    const { trees, workers } = standInTrees();
    const shown = new VolatileTailParser(trees);
    shown.update("Some words", "");
    shown.update("Some words and more", "");
    workers.latest().hold();

    const mounted = new VolatileTailParser(trees);
    mounted.update("Some words and more", "");
    expect(mounted.read()).toStrictEqual(shown.read());
    expect(workers.latest().requests).toHaveLength(1);

    // A parser still waiting on an older tail's parse takes the newer tree the other one shows.
    mounted.update("Other words", "");
    shown.update("Some **bold** words", "");
    workers.latest().release([1]);
    mounted.update("Some **bold** words", "");
    expect(mounted.read()).toStrictEqual(shown.read());
    expect(workers.latest().requests).toHaveLength(3);
  });

  it("names the newest tail as the one shown when two tails mend to the same text", () => {
    const { parser } = tailParser();
    parser.update("Some **bold", "");
    parser.update("Some **bold**", "");
    expect(parser.read()).toMatchObject({ status: "parsed", tailSource: "Some **bold**" });
  });

  it("parses most frames of prose, open emphasis, an open fence and a task item without a whole parse", () => {
    // The point of the parser: a frame that appends words or code lines costs its append.
    const prose =
      "The daemon holds one control lease per shell, so a second client sees the lease and " +
      "waits for it; retry is bounded by the cap, and the reader keeps their place as it grows.";
    const fence = "```ts\n" + "const value = compute(input, { cap: 4096 });\n".repeat(12);
    const openStrong = `Note: **${prose}`;
    // The task item's paragraph starts after its checkbox, on the emphasis, not on a bracket.
    const taskItem = `- [x] *Done:* ${prose}`;
    for (const tail of [prose, fence, openStrong, taskItem]) {
      const { parser, workers } = tailParser();
      const frames = streamedPrefixes(tail, 7);
      for (const prefix of frames) {
        parser.update(prefix, "");
      }
      expect(workers.latest().requests.length).toBeLessThan(frames.length / 4);
    }
  });

  it("keeps the tree on screen until the whole parse lands, and drops one a newer frame passed", async () => {
    const { parser, workers } = tailParser();
    const first = shownAfter(parser, "Some words", "");
    workers.latest().hold();
    // A closing star could pair with an earlier one, so this frame needs a whole parse.
    parser.update("Some words *with emphasis", "");
    expect(parser.read()).toStrictEqual(first);

    // One parse in flight at a time: the newest tail waits for it, never a second request.
    parser.update("Some words *with emphasis* done", "");
    expect(workers.latest().requests).toHaveLength(2);
    workers.latest().release([0]);
    expect(parser.read()).toStrictEqual({
      status: "parsed",
      root: await parseTree(mendVolatileTail("Some words *with emphasis* done")),
      tailSource: "Some words *with emphasis* done",
      definitionPreamble: "",
      settledBlockEnds: [],
    });
  });
});

describe("a tail parsed after the parser's idle stop", () => {
  it("keeps the tree on screen while a new worker loads, then shows the tail's parse", async () => {
    vi.useFakeTimers();
    try {
      const { parser, workers } = tailParser();
      const first = shownAfter(parser, "Some words", "");
      vi.advanceTimersByTime(MARKDOWN_WORKER_IDLE_STOP_MS);
      expect(workers.latest().isTerminated).toBe(true);

      // The next worker keeps the text in its queue until it has loaded the parser.
      workers.loadSlowly();
      parser.update("Some words *with emphasis", "");
      expect(parser.read()).toStrictEqual(first);
      expect(workers.started).toHaveLength(2);
      workers.latest().release([0]);
      expect(parser.read()).toStrictEqual({
        status: "parsed",
        root: await parseTree(mendVolatileTail("Some words *with emphasis")),
        tailSource: "Some words *with emphasis",
        definitionPreamble: "",
        settledBlockEnds: [],
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("mending the volatile tail", () => {
  it("leaves a lone dollar sign unclosed", () => {
    // "it cost $5" is prose, not the start of a formula, so no closing `$` is written after it.
    expect(mendVolatileTail("it cost $5 and then")).toBe("it cost $5 and then");
  });
});
