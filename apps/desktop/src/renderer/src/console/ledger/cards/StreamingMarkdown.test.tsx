// The pipeline, mounted — and the one property the split exists for.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { FootnoteRegistry } from "./markdown/index.js";

/**
 * A body whose first two blocks are the same words, with two more behind them so the
 * settle lag clears and both reach the committed prefix. Repeating a line is the
 * ordinary case for a log or a command snippet, not a contrived one.
 */
const REPEATED_BLOCKS_SETTLED = "same\n\nsame\n\nc\n\nd\n\ne\n\nf";

/** The same body one block earlier, while the second `same` is still in the tail. */
const REPEATED_BLOCKS_STREAMING = "same\n\nsame\n\nc\n\nd\n\ne";

/** A different history entirely — what a rebase hands the segmenter. */
const REBASED_BLOCKS = "other\n\nwords\n\nx\n\ny\n\nz\n\nw";

const PARAGRAPH_SELECTOR = ".meridian-markdown__paragraph";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a streaming body", () => {
  it("renders what has arrived so far", () => {
    const { container } = render(
      <StreamingMarkdown
        publishedText="the first sentence"
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
      />,
    );
    expect(container.textContent).toContain("the first sentence");
  });

  it("does not mount an incomplete construct as itself", () => {
    // Half a fence is not a fence. `remend` closes the tail so the parser sees a
    // complete block, which is why the text renders as code rather than as prose that
    // reflows the moment the closing fence arrives.
    const { container } = render(
      <StreamingMarkdown
        publishedText={"```ts\nconst answer = 1;"}
        sourceId="event-01"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
      />,
    );
    expect(container.querySelector(".meridian-code")).not.toBeNull();
  });

  it("keeps the committed prefix stable as the tail grows", () => {
    const footnotes = new FootnoteRegistry();
    const { container, rerender } = render(
      <StreamingMarkdown
        publishedText={"one\n\ntwo\n\nthree\n\nfour\n\nfi"}
        sourceId="event-01"
        footnotes={footnotes}
        isComplete={false}
      />,
    );
    const before = container.textContent ?? "";
    rerender(
      <StreamingMarkdown
        publishedText={"one\n\ntwo\n\nthree\n\nfour\n\nfive"}
        sourceId="event-01"
        footnotes={footnotes}
        isComplete={false}
      />,
    );
    const after = container.textContent ?? "";
    expect(before).toContain("one");
    expect(after).toContain("one");
    expect(after).toContain("five");
  });

  it("registers the footnote definitions its body declared", () => {
    const footnotes = new FootnoteRegistry();
    render(
      <StreamingMarkdown
        publishedText={"cite[^1]\n\n[^1]: the note\n\nafter\n\ntail\n\nend\n"}
        sourceId="event-07"
        footnotes={footnotes}
        isComplete
      />,
    );
    expect(footnotes.resolve("event-07", "1")).not.toBeUndefined();
  });

  it("gives two identical settled blocks two identities", () => {
    // React reports a duplicate key on `console.error` and then reuses one subtree for
    // both siblings. The spy is the assertion: keying a block by its text alone passes
    // every other case in this file and fails here the moment a message repeats a line.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { container } = render(
      <StreamingMarkdown
        publishedText={REPEATED_BLOCKS_SETTLED}
        sourceId="event-11"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
      />,
    );

    expect(consoleError).not.toHaveBeenCalled();
    const repeated = [...container.querySelectorAll(PARAGRAPH_SELECTOR)].filter(
      (paragraph) => paragraph.textContent === "same",
    );
    expect(repeated).toHaveLength(2);
  });

  it("keeps a settled block's element as later blocks move from the tail into the prefix", () => {
    const footnotes = new FootnoteRegistry();
    const { container, rerender } = render(
      <StreamingMarkdown
        publishedText={REPEATED_BLOCKS_STREAMING}
        sourceId="event-12"
        footnotes={footnotes}
        isComplete={false}
      />,
    );
    const firstSettled = container.querySelector(PARAGRAPH_SELECTOR);

    rerender(
      <StreamingMarkdown
        publishedText={REPEATED_BLOCKS_SETTLED}
        sourceId="event-12"
        footnotes={footnotes}
        isComplete={false}
      />,
    );

    // The prefix is append-only, so block 0 stays block 0 and its key does not move
    // when the block behind it settles — while the newly settled twin is a second
    // element rather than the first one reused.
    const paragraphs = container.querySelectorAll(PARAGRAPH_SELECTOR);
    expect(paragraphs[0]).toBe(firstSettled);
    expect(paragraphs[1]).not.toBe(firstSettled);
    expect(paragraphs[1]?.textContent).toBe("same");
  });

  it("negative control: a rebase remounts rather than reusing the old message's element", () => {
    // Without the block's own text in the key, the position alone would make every key
    // unique and pass the two cases above — and then pour a different history's words
    // into the elements this message left behind.
    const footnotes = new FootnoteRegistry();
    const { container, rerender } = render(
      <StreamingMarkdown
        publishedText={REPEATED_BLOCKS_SETTLED}
        sourceId="event-13"
        footnotes={footnotes}
        isComplete={false}
      />,
    );
    const firstSettled = container.querySelector(PARAGRAPH_SELECTOR);

    rerender(
      <StreamingMarkdown
        publishedText={REBASED_BLOCKS}
        sourceId="event-13"
        footnotes={footnotes}
        isComplete={false}
      />,
    );

    const rebasedFirst = container.querySelector(PARAGRAPH_SELECTOR);
    expect(rebasedFirst?.textContent).toBe("other");
    expect(rebasedFirst).not.toBe(firstSettled);
  });

  it("negative control: it registers nothing for a body with no definitions", () => {
    // Without this, an effect that registered on every render regardless of content
    // would pass the case above and fill the popover host with empty entries.
    const footnotes = new FootnoteRegistry();
    render(
      <StreamingMarkdown
        publishedText="ordinary prose"
        sourceId="event-08"
        footnotes={footnotes}
        isComplete
      />,
    );
    expect(footnotes.definitionCount).toBe(0);
  });
});
