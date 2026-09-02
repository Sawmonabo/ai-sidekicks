// The pipeline, mounted — and the one property the split exists for.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/**
 * A reference and the definition it names, close enough together to parse as one chunk.
 *
 * That is not incidental: GFM resolves a reference against the definitions in its own
 * document, so `[^1]` in a chunk holding no definition is left as literal text and never
 * becomes a reference node at all. A short body renders entirely as the volatile tail,
 * which is one parse.
 */
const CITED_FOOTNOTE = "cite[^1] here\n\n[^1]: the note body\n";

/** A definition the message declares and never points at. */
const UNCITED_FOOTNOTE = "[^1]: the note body\n\nordinary prose\n";

describe("a footnote's definition", () => {
  it("opens into the card's own popover host when its marker is pressed", () => {
    render(
      <StreamingMarkdown
        publishedText={CITED_FOOTNOTE}
        sourceId="event-20"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );

    const marker = screen.getByRole("button", { name: "Footnote 1" });
    // Before the press the body is nowhere on the screen — that was the whole defect:
    // the registry held every definition and nothing ever asked it for one.
    expect(screen.queryByText("the note body")).toBeNull();

    fireEvent.click(marker);

    const body = screen.getByText("the note body");
    const popup = body.closest(".meridian-footnote-popover");
    expect(popup).not.toBeNull();
    // The marker describes itself by the popup it opened, and only while it is the one
    // that opened it.
    expect(marker.getAttribute("aria-describedby")).toBe(popup?.id);
  });

  it("closes on Escape and stops describing the marker", async () => {
    render(
      <StreamingMarkdown
        publishedText={CITED_FOOTNOTE}
        sourceId="event-21"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );
    const marker = screen.getByRole("button", { name: "Footnote 1" });
    fireEvent.click(marker);
    expect(screen.getByText("the note body")).toBeTruthy();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByText("the note body")).toBeNull();
    });
    expect(marker.getAttribute("aria-describedby")).toBeNull();
  });

  it("names a definition nothing in the message refers to", () => {
    // The definition is stripped from the body so its text is not on screen twice. Saying
    // nothing as well would delete an author's note with no record of it at all.
    const { container } = render(
      <StreamingMarkdown
        publishedText={UNCITED_FOOTNOTE}
        sourceId="event-22"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );

    expect(container.textContent).toContain("Defined and never referred to: 1.");
  });

  it("negative control: a definition its message cites is not named as uncited", () => {
    // Without this, a body that reported every definition would put that line under every
    // message carrying a footnote — which is noise where the absence is information.
    const { container } = render(
      <StreamingMarkdown
        publishedText={CITED_FOOTNOTE}
        sourceId="event-23"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );

    expect(container.textContent).not.toContain("Defined and never referred to");
  });

  it("negative control: a streaming body reports no uncited definition", () => {
    // A definition ahead of its own reference is the ordinary shape of a stream, so the
    // question is only asked of a finished body — and a fix that asked it per frame would
    // pay for a deep walk on every token as well as being wrong.
    const { container } = render(
      <StreamingMarkdown
        publishedText={UNCITED_FOOTNOTE}
        sourceId="event-24"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
      />,
    );

    expect(container.textContent).not.toContain("Defined and never referred to");
  });
});
