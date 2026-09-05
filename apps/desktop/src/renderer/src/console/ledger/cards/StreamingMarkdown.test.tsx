// The pipeline, mounted — and the one property the split exists for.
//
// What a FOOTNOTE does across that split is `StreamingMarkdown.footnotes.test.tsx`':
// a definition is the one construct whose meaning depends on a block other than the
// one it sits in, so it needs its own bodies, its own registry assertions, and the
// popover the reference opens.

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

/**
 * A definition far enough behind the tail to have settled, with filler behind it.
 *
 * The settle lag is two blocks, so the definition has to be third from the end
 * before it is in the committed prefix at all — which is what these cases are about.
 */
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

  it("registers nothing again when a re-render carries no new text", () => {
    // The defect the settled-block memoisation exists to prevent, reached through the
    // registration effect instead of through rendering: the settled node lists were
    // rebuilt by a `map` on every render, so an unrelated viewport, layout, or ledger
    // update re-walked every settled block of every long completed message.
    const footnotes = new FootnoteRegistry();
    const register = vi.spyOn(footnotes, "register");
    // A FRESH element each time, carrying the same values. Re-rendering the same
    // element object is a React bail-out — the component would not run at all, and a
    // case built on one would pass over any amount of per-render work.
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
    // And the render did happen — the settled block is the same element rather than a
    // remount, which is the other half of what the memoisation is for.
    expect(container.querySelector(PARAGRAPH_SELECTOR)).toBe(settledBefore);
  });

  it("walks only what changed as the body grows behind a settled definition", () => {
    // A settled block's parse is content-addressed, so a block whose nodes are the
    // ones registered last time holds the definitions registered last time. Growth
    // costs the growth rather than the whole prefix — the same claim the settled-block
    // memo makes about rendering, made about registration.
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

    // Nothing: the arriving blocks declare nothing, and the settled definition behind
    // them is not walked again. On the old code the whole prefix was re-registered on
    // every one of these frames.
    expect(register).not.toHaveBeenCalled();

    // And a block that DOES declare something still lands — restating the body's
    // definitions ahead of every block is what makes a cross-block reference resolve,
    // so a new definition changes the preamble and the prefix is re-read on purpose.
    rerender(
      <StreamingMarkdown
        publishedText={SETTLED_FOOTNOTE_BODY + PLAIN_GROWTH_BLOCKS + GROWN_FOOTNOTE_BLOCK}
        sourceId="event-41"
        footnotes={footnotes}
        isComplete={false}
      />,
    );
    expect(footnotes.resolve("event-41", "2")).not.toBeUndefined();
  });

  it("negative control: a rebase re-registers the prefix it re-derived", () => {
    // Without this, an effect that never re-walked a settled block would pass both
    // cases above and leave the previous history's definitions answering this one's
    // references.
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
    expect(footnotes.resolve("event-42", "1")?.bodyNodes).not.toBeUndefined();
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

/** A construct whose author never closed it — bold that opens and simply stops. */
const UNCLOSED_EMPHASIS = "a settled paragraph\n\nthis is **bold";

describe("a body the sender has finished", () => {
  it("keeps every block settled, so nothing complete is rewritten by the mender", () => {
    // `remend` exists for a PREFIX. Run over a finished body it closes what the author
    // deliberately left open, and the reader is shown emphasis nobody wrote.
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
    // Without this, a component that simply stopped mending would pass the case above
    // and reflow every half-typed construct on the screen as it arrived.
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
