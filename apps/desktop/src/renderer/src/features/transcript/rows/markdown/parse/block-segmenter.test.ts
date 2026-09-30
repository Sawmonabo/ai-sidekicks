// A block is committed only when a later non-blank line proves it ended: a blank run at the end
// of a snapshot is not evidence, since the next character can be a lazy continuation. So every
// fixture expecting a commit has a further non-blank line after the boundary.

import { describe, expect, it } from "vitest";

import { MARKDOWN_SETTLE_LAG_BLOCKS } from "./segmentation-bounds.js";
import { MarkdownBlockSegmenter } from "./block-segmenter.js";

/** Five paragraphs, the last of them still arriving. */
const FIVE_PARAGRAPHS = "one\n\ntwo\n\nthree\n\nfour\n\nfive";

describe("splitting a stream into settled blocks and a volatile tail", () => {
  it("settles nothing until the lag is cleared", () => {
    const segmenter = new MarkdownBlockSegmenter();
    const first = segmenter.segment("one\n\ntwo\n\nthree");
    expect(segmenter.completeBlockCount).toBeLessThanOrEqual(MARKDOWN_SETTLE_LAG_BLOCKS);
    expect(first.settledBlocks).toStrictEqual([]);
    expect(first.volatileTail).toContain("one");
    expect(first.volatileTail).toContain("three");
  });

  it("settles a block once the lag has moved past it", () => {
    const segmenter = new MarkdownBlockSegmenter();
    const segmentation = segmenter.segment(FIVE_PARAGRAPHS);
    expect(segmenter.completeBlockCount).toBe(3);
    expect(segmentation.settledBlocks).toHaveLength(3 - MARKDOWN_SETTLE_LAG_BLOCKS);
    expect(segmentation.settledBlocks[0]).toContain("one");
    expect(segmentation.volatileTail).toContain("five");
  });

  it("is incremental: a settled block's text does not change as the stream grows", () => {
    const segmenter = new MarkdownBlockSegmenter();
    segmenter.segment(FIVE_PARAGRAPHS);
    const before = segmenter.segment(FIVE_PARAGRAPHS).settledBlocks;
    const after = segmenter.segment(`${FIVE_PARAGRAPHS} and more`).settledBlocks;
    expect(after).toStrictEqual(before);
  });

  it("never settles a boundary inside a fence", () => {
    // A blank line inside a code fence is content, not a block boundary.
    const segmenter = new MarkdownBlockSegmenter();
    const fenced = "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nafter\n\ntail\n\nlast\n\nend";
    const segmentation = segmenter.segment(fenced);
    expect(segmentation.settledBlocks[0]).toContain("```ts");
    expect(segmentation.settledBlocks[0]).toContain("const b = 2;");
  });

  it("treats a tilde fence the same way", () => {
    const segmenter = new MarkdownBlockSegmenter();
    const fenced = "~~~\nline\n\nline\n~~~\n\nafter\n\ntail\n\nlast\n\nend";
    expect(segmenter.segment(fenced).settledBlocks[0]).toContain("~~~");
  });

  it("resets rather than gluing a new history onto an old tail", () => {
    const segmenter = new MarkdownBlockSegmenter();
    segmenter.segment(FIVE_PARAGRAPHS);
    const rebased = segmenter.segment("different\n\ntext");
    expect(rebased.settledBlocks).toStrictEqual([]);
    expect(rebased.volatileTail).toContain("different");
    expect(rebased.volatileTail).not.toContain("one");
  });

  it("settles every block and empties the tail once the body is final", () => {
    // Both reasons this class holds text back concern a later character; a final body has none.
    const segmenter = new MarkdownBlockSegmenter();
    const segmentation = segmenter.segment(FIVE_PARAGRAPHS, { isFinal: true });
    expect(segmentation.volatileTail).toBe("");
    expect(segmentation.settledBlocks.join("")).toBe(FIVE_PARAGRAPHS);
    expect(segmentation.settledBlocks).toHaveLength(5);
  });

  it("commits an unterminated final line rather than holding it as a remainder", () => {
    const segmentation = new MarkdownBlockSegmenter().segment("only a paragraph", {
      isFinal: true,
    });
    expect(segmentation.settledBlocks).toStrictEqual(["only a paragraph"]);
    expect(segmentation.volatileTail).toBe("");
  });

  it("keeps a final unclosed fence in one block rather than splitting its interior", () => {
    // The parser closes an open fence at the end of the document; splitting on the blank line
    // inside it would render half the code as prose.
    const segmentation = new MarkdownBlockSegmenter().segment(
      "```ts\nconst a = 1;\n\nconst b = 2;",
      {
        isFinal: true,
      },
    );
    expect(segmentation.settledBlocks).toHaveLength(1);
    expect(segmentation.settledBlocks[0]).toContain("const b = 2;");
  });

  it("negative control: the same snapshot still holds the lag while the body is in flight", () => {
    const segmentation = new MarkdownBlockSegmenter().segment(FIVE_PARAGRAPHS);
    expect(segmentation.settledBlocks).toHaveLength(3 - MARKDOWN_SETTLE_LAG_BLOCKS);
    expect(segmentation.volatileTail).toContain("five");
  });

  it("negative control: a blank run at the end of the snapshot commits nothing", () => {
    const segmenter = new MarkdownBlockSegmenter();
    const segmentation = segmenter.segment("one\n\ntwo\n\nthree");
    expect(segmenter.completeBlockCount).toBe(1);
    expect(segmentation.volatileTail).toContain("two");
    expect(segmentation.volatileTail).toContain("three");
  });
});

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
    expect(new MarkdownBlockSegmenter().segment(source).settledBlocks[0]).toBe(expectedFirstBlock);
  });

  it("negative control: a paragraph still ends at its blank line", () => {
    const segmentation = new MarkdownBlockSegmenter().segment(
      "first paragraph\n\nsecond paragraph\n\nafter\n\ntail\n\nlast\n\nend",
    );
    expect(segmentation.settledBlocks[0]).toBe("first paragraph\n\n");
  });

  it("negative control: a list that opens after a paragraph is its own block", () => {
    // The container is read from the line the block opened on, not the one after the blank run.
    const segmentation = new MarkdownBlockSegmenter().segment(
      "a paragraph\n\n- an item\n\nafter\n\ntail\n\nlast\n\nend",
    );
    expect(segmentation.settledBlocks[0]).toBe("a paragraph\n\n");
  });

  it("negative control: a differently marked list is a different list", () => {
    // Commonmark starts a new list when the bullet character changes.
    const segmentation = new MarkdownBlockSegmenter().segment(
      "- a\n\n* b\n\nafter\n\ntail\n\nlast\n\nend",
    );
    expect(segmentation.settledBlocks[0]).toBe("- a\n\n");
  });

  it("negative control: a paragraph at column zero ends the list above it", () => {
    const segmentation = new MarkdownBlockSegmenter().segment(
      "- an item\n\nback at the margin\n\nafter\n\ntail\n\nlast\n\nend",
    );
    expect(segmentation.settledBlocks[0]).toBe("- an item\n\n");
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
    expect(new MarkdownBlockSegmenter().segment(source).volatileTail).toBe(expectedTail);
  });

  it("negative control: the separator itself is still removed", () => {
    // The blank run here is longer than the one the commit consumed, so the lagged block the
    // tail is joined from begins on one.
    const segmentation = new MarkdownBlockSegmenter().segment(
      "one\n\n\n\ntwo\n\nthree\n\nfour\n\nfive",
    );

    expect(segmentation.volatileTail.startsWith("\n")).toBe(false);
    expect(segmentation.volatileTail).toContain("two");
    expect(segmentation.volatileTail).toContain("five");
  });
});
