// A block is committed only when a later non-blank line proves it ended: a blank run at the end
// of a snapshot is not evidence, since the next character can be a lazy continuation. So every
// fixture expecting a commit has a further non-blank line after the boundary.

import { describe, expect, it } from "vitest";

import { REVEAL_TEXT_CHUNK_CHARACTERS } from "#renderer/features/transcript/reveal/caps.js";
import { publishedTextOf } from "#renderer/features/transcript/reveal/published-text.js";
import { RevealTextRope } from "#renderer/features/transcript/reveal/text-rope.js";
import { MARKDOWN_SETTLE_LAG_BLOCKS } from "./segmentation-measures.js";
import { MarkdownBlockSegmenter, type MarkdownSegmentation } from "./block-segmenter.js";

/** Five paragraphs, the last of them still arriving. */
const FIVE_PARAGRAPHS = "one\n\ntwo\n\nthree\n\nfour\n\nfive";

/** The settled blocks' text, cut from the snapshot their ranges index. */
function settledTextsOf(segmentation: MarkdownSegmentation): string[] {
  return segmentation.settledBlocks.map(({ start, end }) => segmentation.source.slice(start, end));
}

describe("splitting a stream into settled blocks and a volatile tail", () => {
  it("settles a block once the lag has moved past it", () => {
    const segmenter = new MarkdownBlockSegmenter();
    const segmentation = segmenter.segment(publishedTextOf(FIVE_PARAGRAPHS));
    expect(segmentation.settledBlocks).toHaveLength(3 - MARKDOWN_SETTLE_LAG_BLOCKS);
    expect(settledTextsOf(segmentation)[0]).toContain("one");
    expect(segmentation.volatileTail).toContain("five");
  });

  it("is incremental: a settled block's text does not change as the stream grows", () => {
    const segmenter = new MarkdownBlockSegmenter();
    segmenter.segment(publishedTextOf(FIVE_PARAGRAPHS));
    const before = settledTextsOf(segmenter.segment(publishedTextOf(FIVE_PARAGRAPHS)));
    const after = settledTextsOf(segmenter.segment(publishedTextOf(`${FIVE_PARAGRAPHS} and more`)));
    expect(after).toStrictEqual(before);
  });

  it("never settles a boundary inside a fence", () => {
    // A blank line inside a code fence is content, not a block boundary.
    const segmenter = new MarkdownBlockSegmenter();
    const fenced = "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter\n\ntail\n\nlast\n\nend";
    const firstBlock = settledTextsOf(segmenter.segment(publishedTextOf(fenced)))[0];
    expect(firstBlock).toContain("```ts");
    expect(firstBlock).toContain("const b = 2;");
  });

  it("resets rather than gluing a new history onto an old tail", () => {
    const segmenter = new MarkdownBlockSegmenter();
    segmenter.segment(publishedTextOf(FIVE_PARAGRAPHS));
    const rebased = segmenter.segment(publishedTextOf("different\n\ntext"));
    expect(rebased.settledBlocks).toStrictEqual([]);
    expect(rebased.volatileTail).toContain("different");
    expect(rebased.volatileTail).not.toContain("one");

    // The same through one lane's handle, rewritten in place under the segmenter. The rewrite is
    // longer than what was scanned, so only the rope's record of the cut can say it is not an
    // extension.
    const lane = revealedRope([FIVE_PARAGRAPHS]);
    const laneSegmenter = new MarkdownBlockSegmenter();
    const before = laneSegmenter.segment(lane);
    expect(before.settledBlocks).not.toStrictEqual([]);
    const rewrite = `different\n\n${FIVE_PARAGRAPHS.toUpperCase()}`;
    lane.rebase(rewrite, 0);
    lane.advance(Number.MAX_SAFE_INTEGER);
    const rebasedLane = laneSegmenter.segment(lane);
    expect(rebasedLane.generation).not.toBe(before.generation);
    expect(settledTextsOf(rebasedLane)).toStrictEqual(
      settledTextsOf(new MarkdownBlockSegmenter().segment(publishedTextOf(rewrite))),
    );
    expect(rebasedLane.volatileTail).not.toContain("one");
  });

  it("settles every block and empties the tail once the body is final", () => {
    // Both reasons this class holds text back concern a later character; a final body has none.
    const segmenter = new MarkdownBlockSegmenter();
    const segmentation = segmenter.segment(publishedTextOf(FIVE_PARAGRAPHS), { isFinal: true });
    expect(segmentation.volatileTail).toBe("");
    expect(settledTextsOf(segmentation).join("")).toBe(FIVE_PARAGRAPHS);
    expect(segmentation.settledBlocks).toHaveLength(5);
  });

  it("commits an unterminated final line rather than holding it as a remainder", () => {
    const segmentation = new MarkdownBlockSegmenter().segment(publishedTextOf("only a paragraph"), {
      isFinal: true,
    });
    expect(settledTextsOf(segmentation)).toStrictEqual(["only a paragraph"]);
    expect(segmentation.volatileTail).toBe("");
  });

  it("keeps a final unclosed fence in one block rather than splitting its interior", () => {
    // The parser closes an open fence at the end of the document; splitting on the blank line
    // inside it would render half the code as prose.
    const segmentation = new MarkdownBlockSegmenter().segment(
      publishedTextOf("```ts\nconst a = 1;\n\nconst b = 2;"),
      {
        isFinal: true,
      },
    );
    expect(settledTextsOf(segmentation)).toHaveLength(1);
    expect(settledTextsOf(segmentation)[0]).toContain("const b = 2;");
  });

  it("a blank run at the end of the snapshot commits nothing", () => {
    // The last line is whole in both, so only the blank run after it differs.
    const withoutBlankRun = new MarkdownBlockSegmenter().segment(
      publishedTextOf(`${FIVE_PARAGRAPHS}\n`),
    );
    const withBlankRun = new MarkdownBlockSegmenter().segment(
      publishedTextOf(`${FIVE_PARAGRAPHS}\n\n\n`),
    );
    expect(settledTextsOf(withBlankRun)).toStrictEqual(settledTextsOf(withoutBlankRun));
    expect(withBlankRun.volatileTail).toContain("five");
  });
});

describe("splitting a lane's text held in chunks", () => {
  it("cuts the blocks a whole string cuts, wherever a chunk edge falls against a boundary", () => {
    // A paragraph ending one, two and three characters before a chunk edge puts the blank line
    // before the edge, across it and after it.
    for (const shortfall of [1, 2, 3]) {
      const opening = `${"a".repeat(REVEAL_TEXT_CHUNK_CHARACTERS - shortfall)}\n\n`;
      const source = `${opening}second\n\n${"b".repeat(REVEAL_TEXT_CHUNK_CHARACTERS)}\n\nc\n\nd`;
      const whole = new MarkdownBlockSegmenter().segment(publishedTextOf(source));

      // Revealed a frame at a time, so the scan resumes from inside a chunk as the text grows.
      const lane = new RevealTextRope("lane-1");
      lane.append(source);
      const segmenter = new MarkdownBlockSegmenter();
      let segmentation = segmenter.segment(lane);
      while (!lane.isSettled) {
        lane.advance(97);
        segmentation = segmenter.segment(lane);
      }

      expect(segmentation.settledBlocks).toStrictEqual(whole.settledBlocks);
      expect(settledTextsOf(segmentation)).toStrictEqual(settledTextsOf(whole));
      expect(settledTextsOf(segmentation)[0]).toBe(opening);
      expect(segmentation.volatileTail).toBe(whole.volatileTail);
    }
  });
});

/** A lane's rope with every character of `appends` revealed. */
function revealedRope(appends: readonly string[]): RevealTextRope {
  const rope = new RevealTextRope("lane-1");
  for (const text of appends) {
    rope.append(text);
  }
  rope.advance(Number.MAX_SAFE_INTEGER);
  return rope;
}

/**
 * Blocks whose interior blank line is content. Each source ends in a further paragraph so the
 * container's own commit is proved.
 */
const CONTAINER_CASES: readonly {
  readonly what: string;
  readonly source: string;
  readonly expectedFirstBlock: string;
}[] = [
  {
    what: "a list item's second paragraph, which is what makes the list loose",
    source: "- first\n\n  second paragraph\n\nafter\n\ntail\n\nlast\n\nend",
    expectedFirstBlock: "- first\n\n  second paragraph\n\n",
  },
  {
    what: "a sibling item after a blank line, which is one loose list and not two tight ones",
    source: "- a\n\n- b\n\nafter\n\ntail\n\nlast\n\nend",
    expectedFirstBlock: "- a\n\n- b\n\n",
  },
  {
    what: "an ordered item's continuation, whose indent is the marker's width and not one",
    source: "1. first\n\n   second paragraph\n\nafter\n\ntail\n\nlast\n\nend",
    expectedFirstBlock: "1. first\n\n   second paragraph\n\n",
  },
  {
    what: "an indented code block holding a blank line between two commands",
    source: "    one --flag\n\n    two --flag\n\nafter\n\ntail\n\nlast\n\nend",
    expectedFirstBlock: "    one --flag\n\n    two --flag\n\n",
  },
];

describe("a blank line inside a container", () => {
  it.each(CONTAINER_CASES)("keeps $what in one block", ({ source, expectedFirstBlock }) => {
    expect(settledTextsOf(new MarkdownBlockSegmenter().segment(publishedTextOf(source)))[0]).toBe(
      expectedFirstBlock,
    );
  });
});

/**
 * What the tail keeps and drops: the separator ahead of it is the previous block's, but the first
 * content line's indentation is the author's and is syntax in commonmark.
 */
const LEADING_WHITESPACE_CASES: readonly {
  readonly what: string;
  readonly source: string;
  readonly expectedTail: string;
}[] = [
  {
    what: "a four-space indented code block, whose indentation is what makes it code",
    source: "    command --flag",
    expectedTail: "    command --flag",
  },
  {
    what: "a tab-indented block, which opens the same construct",
    source: "\tcommand --flag",
    expectedTail: "\tcommand --flag",
  },
  {
    what: "blank separator lines before a paragraph, which are the previous block's",
    source: "\n\nafter the blanks",
    expectedTail: "after the blanks",
  },
  {
    what: "separator lines — one of them holding spaces — before an indented block",
    source: "\n \n    command --flag",
    expectedTail: "    command --flag",
  },
];

describe("what the volatile tail strips from its own head", () => {
  it.each(LEADING_WHITESPACE_CASES)("keeps $what", ({ source, expectedTail }) => {
    expect(new MarkdownBlockSegmenter().segment(publishedTextOf(source)).volatileTail).toBe(
      expectedTail,
    );
  });
});
