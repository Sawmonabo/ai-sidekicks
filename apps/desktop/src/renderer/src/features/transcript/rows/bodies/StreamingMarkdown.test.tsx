// Footnotes across the settle split are covered in `StreamingMarkdown.footnotes.test.tsx`.

import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { duplicateKeyReports, reportsWhileReactRan } from "@test/helpers/react-reports.js";
import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { FootnoteRegistry } from "../markdown/footnotes/footnote-registry.js";

/** A body whose first two blocks repeat, with two more behind them so both settle. */
const REPEATED_BLOCKS_SETTLED = "same\n\nsame\n\nc\n\nd\n\ne\n\nf";

/** The same body one block earlier, while the second `same` is still in the tail. */
const REPEATED_BLOCKS_STREAMING = "same\n\nsame\n\nc\n\nd\n\ne";

/** A different history entirely — what a rebase hands the segmenter. */
const REBASED_BLOCKS = "other\n\nwords\n\nx\n\ny\n\nz\n\nw";

const PARAGRAPH_SELECTOR = ".meridian-markdown__paragraph";

/** A definition far enough behind the tail to have settled (the settle lag is two blocks). */
const SETTLED_FOOTNOTE_BODY =
  "[^1]: the first note\n\nfiller one\n\nfiller two\n\nfiller three\n\n";

/** More blocks behind it, declaring nothing — the ordinary shape of a body growing. */
const PLAIN_GROWTH_BLOCKS = "filler four\n\nfiller five\n\nfiller six\n\n";

/** One more settled block, carrying a definition of its own. */
const GROWN_FOOTNOTE_BLOCK = "[^2]: the second note\n\nfiller seven\n\nfiller eight\n\n";

/** The same shape from a different history — what a rebase hands the segmenter. */
const REBASED_FOOTNOTE_BODY = "[^1]: a different note\n\nother one\n\nother two\n\nother three\n\n";

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
    // `remend` closes the tail, so half a fence renders as code rather than as prose that
    // reflows when the closing fence arrives.
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
    expect(footnotes.definitionsFor("event-07").get("1")).not.toBeUndefined();
  });

  it("gives two identical settled blocks two identities", async () => {
    // React reports a duplicate key on `console.error`; keying by text alone fails here when a
    // message repeats a line.
    const {
      value: { container },
      reported,
    } = await reportsWhileReactRan(() =>
      render(
        <StreamingMarkdown
          publishedText={REPEATED_BLOCKS_SETTLED}
          sourceId="event-11"
          footnotes={new FootnoteRegistry()}
          isComplete={false}
        />,
      ),
    );

    expect(duplicateKeyReports(reported)).toStrictEqual([]);
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

    // The prefix is append-only, so block 0 keeps its key when a later block settles.
    const paragraphs = container.querySelectorAll(PARAGRAPH_SELECTOR);
    expect(paragraphs[0]).toBe(firstSettled);
    expect(paragraphs[1]).not.toBe(firstSettled);
    expect(paragraphs[1]?.textContent).toBe("same");
  });

  it("negative control: a rebase remounts rather than reusing the old message's element", () => {
    // Position alone would make every key unique; the text in the key is what remounts.
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

  it("registers nothing again when a re-render carries no new text", () => {
    // Registration must not re-walk settled blocks on a re-render that carries no new text.
    const footnotes = new FootnoteRegistry();
    const register = vi.spyOn(footnotes, "register");
    // A fresh element each time: re-rendering the same element object is a React bail-out
    // that would skip the component.
    const bodyWithNoNewText = (): React.JSX.Element => (
      <StreamingMarkdown
        publishedText={SETTLED_FOOTNOTE_BODY}
        sourceId="event-40"
        footnotes={footnotes}
        isComplete
      />
    );
    const { container, rerender } = render(bodyWithNoNewText());
    expect(register).toHaveBeenCalledTimes(1);
    const settledBefore = container.querySelector(PARAGRAPH_SELECTOR);
    register.mockClear();

    rerender(bodyWithNoNewText());
    rerender(bodyWithNoNewText());

    expect(register).not.toHaveBeenCalled();
    // And the settled block is the same element, not a remount.
    expect(container.querySelector(PARAGRAPH_SELECTOR)).toBe(settledBefore);
  });

  it("walks only what changed as the body grows behind a settled definition", () => {
    // A settled block's nodes are referentially stable, so growth costs only the new blocks.
    const footnotes = new FootnoteRegistry();
    const register = vi.spyOn(footnotes, "register");
    const { rerender } = render(
      <StreamingMarkdown
        publishedText={SETTLED_FOOTNOTE_BODY}
        sourceId="event-41"
        footnotes={footnotes}
        isComplete={false}
      />,
    );
    register.mockClear();

    rerender(
      <StreamingMarkdown
        publishedText={SETTLED_FOOTNOTE_BODY + PLAIN_GROWTH_BLOCKS}
        sourceId="event-41"
        footnotes={footnotes}
        isComplete={false}
      />,
    );

    // The arriving blocks declare nothing, and the settled definition is not walked again.
    expect(register).not.toHaveBeenCalled();

    // A new definition changes the preamble, so the prefix is re-read on purpose.
    rerender(
      <StreamingMarkdown
        publishedText={SETTLED_FOOTNOTE_BODY + PLAIN_GROWTH_BLOCKS + GROWN_FOOTNOTE_BLOCK}
        sourceId="event-41"
        footnotes={footnotes}
        isComplete={false}
      />,
    );
    expect(footnotes.definitionsFor("event-41").get("2")).not.toBeUndefined();
  });

  it("negative control: a rebase re-registers the prefix it re-derived", () => {
    // A settled block re-derived from a different history must register again.
    const footnotes = new FootnoteRegistry();
    const register = vi.spyOn(footnotes, "register");
    const { rerender } = render(
      <StreamingMarkdown
        publishedText={SETTLED_FOOTNOTE_BODY}
        sourceId="event-42"
        footnotes={footnotes}
        isComplete={false}
      />,
    );
    register.mockClear();

    rerender(
      <StreamingMarkdown
        publishedText={REBASED_FOOTNOTE_BODY}
        sourceId="event-42"
        footnotes={footnotes}
        isComplete={false}
      />,
    );

    expect(register).toHaveBeenCalled();
    expect(footnotes.definitionsFor("event-42").get("1")?.bodyNodes).not.toBeUndefined();
  });

  it("negative control: it registers nothing for a body with no definitions", () => {
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

/** A construct whose author never closed it — bold that opens and simply stops. */
const UNCLOSED_EMPHASIS = "a settled paragraph\n\nthis is **bold";

describe("a body the sender has finished", () => {
  it("keeps every block settled, so nothing complete is rewritten by the mender", () => {
    // `remend` is for a prefix; on a finished body it would close emphasis the author left open.
    const { container } = render(
      <StreamingMarkdown
        publishedText={UNCLOSED_EMPHASIS}
        sourceId="event-33"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("**bold");
  });

  it("negative control: the same text mid-stream is still mended", () => {
    const { container } = render(
      <StreamingMarkdown
        publishedText={UNCLOSED_EMPHASIS}
        sourceId="event-34"
        footnotes={new FootnoteRegistry()}
        isComplete={false}
      />,
    );
    expect(container.querySelector("strong")).not.toBeNull();
  });
});
