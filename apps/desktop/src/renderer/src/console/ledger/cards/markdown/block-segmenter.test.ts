// The committed-and-volatile split: where a block ends, and what is still moving.
//
// A BLOCK IS COMMITTED ONLY WHEN A LATER NON-BLANK LINE PROVES IT ENDED, which is the
// rule most of these cases are really about. A blank run at the very end of a snapshot
// is not evidence: the next character to arrive can be a lazy continuation, and a
// segmenter that committed on the blank alone would settle a block the stream then
// extended. So every fixture below that expects a commit has a further non-blank line
// after the boundary.

import { describe, expect, it } from "vitest";

import { MARKDOWN_SETTLE_LAG_BLOCKS } from "../card-bounds.js";
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
    // A blank line inside a code fence is content, not a block boundary. Settling there
    // would hand the parser half a fence and render the rest of the message as code.
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
    // Both reasons this class holds text back are reasons about a LATER character, and
    // a final body has none. Held back, these blocks never reach the settled cache and
    // stay on the `remend`ed path — a complete body's text rewritten as if it were a
    // prefix.
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
    // A complete body whose author left a fence open is still one block: the parser
    // closes it at the end of the document, and splitting on the blank line inside it
    // would render half the code as prose.
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
    // Without this, a segmenter that ignored the flag and settled everything would pass
    // the three cases above and settle blocks the next character could still reopen.
    const segmentation = new MarkdownBlockSegmenter().segment(FIVE_PARAGRAPHS);
    expect(segmentation.settledBlocks).toHaveLength(3 - MARKDOWN_SETTLE_LAG_BLOCKS);
    expect(segmentation.volatileTail).toContain("five");
  });

  it("negative control: a blank run at the end of the snapshot commits nothing", () => {
    // Without this, a segmenter that split on any blank run would pass every case above
    // and settle a block the very next character could still extend.
    const segmenter = new MarkdownBlockSegmenter();
    const segmentation = segmenter.segment("one\n\ntwo\n\nthree");
    expect(segmenter.completeBlockCount).toBe(1);
    expect(segmentation.volatileTail).toContain("two");
    expect(segmentation.volatileTail).toContain("three");
  });
});

/**
 * What the tail keeps and what it drops, in the one place the two are confusable.
 *
 * The separator ahead of the tail is the previous block's, and dropping it is all the
 * tail owes. The first content line's own indentation is the AUTHOR's, and in
 * commonmark it is syntax rather than layout.
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
    // Without this, a segmenter that stripped NOTHING would pass every case above and
    // hand the parser a tail opening on blank lines. The run of blanks here is longer
    // than the one the commit consumed, so the lagged block the tail is joined from
    // begins on one — which is the only way the tail ever does.
    const segmentation = new MarkdownBlockSegmenter().segment(
      "one\n\n\n\ntwo\n\nthree\n\nfour\n\nfive",
    );

    expect(segmentation.volatileTail.startsWith("\n")).toBe(false);
    expect(segmentation.volatileTail).toContain("two");
    expect(segmentation.volatileTail).toContain("five");
  });
});
