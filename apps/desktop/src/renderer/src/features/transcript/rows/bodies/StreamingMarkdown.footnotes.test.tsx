// A footnote across the settle boundary, mounted.
//
// Its own file beside `StreamingMarkdown.test.tsx` because a definition is the one
// construct whose meaning depends on a block other than the one it sits in: GFM
// resolves a reference against the definitions in its OWN document, and the streaming
// pipeline hands the parser a committed prefix and a volatile tail as two documents.
// So the cases here need bodies built around that boundary, and they assert on the
// markers rather than on the paragraphs the sibling suite counts.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { FootnoteRegistry } from "@renderer/console/ledger/cards/markdown/index.js";

/**
 * A citation far enough ahead of its definition that the citing block settles first.
 *
 * The filler is what makes this the ordinary long-message case rather than a contrived
 * one: with two blocks of settle lag, the citing block is committed and parsed as its
 * own document long before `[^1]: …` arrives at the end of the body.
 */
const CROSS_BLOCK_FOOTNOTE =
  "cite[^1] here\n\nfiller one\n\nfiller two\n\nfiller three\n\n[^1]: the note body\n";

describe("a footnote whose definition settles in another block", () => {
  it("is a real reference marker", () => {
    render(
      <StreamingMarkdown
        publishedText={CROSS_BLOCK_FOOTNOTE}
        sourceId="event-30"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );

    // Parsed block-by-block with nothing else in scope, `[^1]` is literal text: no node,
    // no marker. The whole body's definitions are restated ahead of each block precisely
    // so this marker exists.
    const marker = screen.getByLabelText("Footnote 1");
    expect(marker.getAttribute("data-defined")).toBe("true");
  });

  it("negative control: an identifier the body never defines stays literal", () => {
    // Without this, a preamble built from anything other than the body's own
    // definitions — every identifier ever seen, say — would pass the cases above and
    // mint markers for notes that do not exist.
    const { container } = render(
      <StreamingMarkdown
        publishedText={"cite[^99] here\n\nfiller one\n\nfiller two\n\nfiller three\n"}
        sourceId="event-32"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );
    expect(container.querySelector(".meridian-markdown__footnote")).toBeNull();
    expect(container.textContent).toContain("[^99]");
  });
});
