import { render, screen, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { duplicateKeyReports, reportsWhileReactRan } from "#test/helpers/react-reports.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { liveBridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { FootnoteRegistry } from "../markdown/footnotes/registry.js";
import { publishedTextOf } from "../../reveal/published-text.js";

/** A markdown body drawn inside a window, which supplies its code colors. */
function renderInWindow(body: React.JSX.Element): RenderResult {
  return render(body, { wrapper: liveBridgeWrapper() });
}

/** A body whose first two blocks repeat, with two more behind them so both settle. */
const REPEATED_BLOCKS_SETTLED = "same\n\nsame\n\nc\n\nd\n\ne\n\nf";

/** A different history entirely — what a rebase hands the segmenter. */
const REBASED_BLOCKS = "other\n\nwords\n\nx\n\ny\n\nz\n\nw";

const PARAGRAPH_SELECTOR = ".meridian-markdown__paragraph";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a streaming body", () => {
  it("renders what has arrived so far", () => {
    const { container } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf("the first sentence")}
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersCodeCopy={false}
      />,
    );
    expect(container.textContent).toContain("the first sentence");
  });

  it("gives two identical settled blocks two identities", async () => {
    // React reports a duplicate key on `console.error`; keying by text alone fails here when a
    // message repeats a line.
    const {
      value: { container },
      reported,
    } = await reportsWhileReactRan(() =>
      renderInWindow(
        <StreamingMarkdown
          publishedText={publishedTextOf(REPEATED_BLOCKS_SETTLED)}
          sourceId="event-11"
          footnotes={new FootnoteRegistry()}
          isComplete={false}
          offersCodeCopy={false}
        />,
      ),
    );

    expect(duplicateKeyReports(reported)).toStrictEqual([]);
    const repeated = [...container.querySelectorAll(PARAGRAPH_SELECTOR)].filter(
      (paragraph) => paragraph.textContent === "same",
    );
    expect(repeated).toHaveLength(2);
  });

  it("keeps a settled block's element as later blocks settle behind it", () => {
    // The last line is unterminated and two blocks lag behind it, so only the first two settle.
    const { container, rerender } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf("first\n\nsecond\n\nthird\n\nfourth\n\nfifth")}
        sourceId="event-12"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersCodeCopy={false}
      />,
    );
    const firstSettled = container.querySelector(PARAGRAPH_SELECTOR);
    expect(firstSettled?.textContent).toBe("first");

    rerender(
      <StreamingMarkdown
        publishedText={publishedTextOf(
          "first\n\nsecond\n\nthird\n\nfourth\n\nfifth\n\nsixth\n\nseventh",
        )}
        sourceId="event-12"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
        offersCodeCopy={false}
      />,
    );

    expect(container.querySelector(PARAGRAPH_SELECTOR)).toBe(firstSettled);
  });

  it("a rebase remounts rather than reusing the old message's element", () => {
    // Position alone would make every key unique; the text's fingerprint in the key remounts.
    const footnotes = new FootnoteRegistry();
    const { container, rerender } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(REPEATED_BLOCKS_SETTLED)}
        sourceId="event-13"
        footnotes={footnotes}
        isComplete={false}
        offersCodeCopy={false}
      />,
    );
    const firstSettled = container.querySelector(PARAGRAPH_SELECTOR);

    rerender(
      <StreamingMarkdown
        publishedText={publishedTextOf(REBASED_BLOCKS)}
        sourceId="event-13"
        footnotes={footnotes}
        isComplete={false}
        offersCodeCopy={false}
      />,
    );

    const rebasedFirst = container.querySelector(PARAGRAPH_SELECTOR);
    expect(rebasedFirst?.textContent).toBe("other");
    expect(rebasedFirst).not.toBe(firstSettled);
  });
});

/** A construct whose author never closed it — bold that opens and simply stops. */
const UNCLOSED_EMPHASIS = "a settled paragraph\n\nthis is **bold";

describe("a body the sender has finished", () => {
  it("keeps every block settled, so nothing complete is rewritten by the mender", () => {
    // `remend` is for a prefix; on a finished body it would close emphasis the author left open.
    const { container } = renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(UNCLOSED_EMPHASIS)}
        sourceId="event-33"
        footnotes={new FootnoteRegistry()}
        isComplete
        offersCodeCopy={false}
      />,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("**bold");
  });
});

/**
 * A citation far enough ahead of its definition that the citing block settles first (the
 * settle lag is two blocks).
 */
const CROSS_BLOCK_FOOTNOTE =
  "cite[^1] here\n\nfiller one\n\nfiller two\n\nfiller three\n\n[^1]: the note body\n";

// A definition is the one construct whose meaning depends on another block: the streaming
// pipeline hands the parser the committed prefix and the volatile tail as two documents.
describe("a footnote whose definition settles in another block", () => {
  it("is a real reference marker", () => {
    renderInWindow(
      <StreamingMarkdown
        publishedText={publishedTextOf(CROSS_BLOCK_FOOTNOTE)}
        sourceId="event-30"
        footnotes={new FootnoteRegistry()}
        isComplete
        offersCodeCopy={false}
      />,
    );

    // Parsed block by block, `[^1]` would be literal text; the body's definitions are
    // restated ahead of each block so the marker exists.
    const marker = screen.getByLabelText("Footnote 1");
    expect(marker.getAttribute("data-defined")).toBe("true");
  });
});
