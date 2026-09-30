// A definition is the one construct whose meaning depends on another block: the streaming
// pipeline hands the parser the committed prefix and the volatile tail as two documents.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { FootnoteRegistry } from "../markdown/footnotes/footnote-registry.js";

/**
 * A citation far enough ahead of its definition that the citing block settles first (the
 * settle lag is two blocks).
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

    // Parsed block by block, `[^1]` would be literal text; the body's definitions are
    // restated ahead of each block so the marker exists.
    const marker = screen.getByLabelText("Footnote 1");
    expect(marker.getAttribute("data-defined")).toBe("true");
  });

  it("negative control: an identifier the body never defines stays literal", () => {
    // A preamble built from anything but the body's own definitions would mint markers for
    // notes that do not exist.
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
