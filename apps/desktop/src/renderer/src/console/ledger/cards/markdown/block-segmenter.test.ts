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
