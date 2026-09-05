// A footnote across the settle boundary, mounted.
//
// Its own file beside `StreamingMarkdown.test.tsx` because a definition is the one
// construct whose meaning depends on a block other than the one it sits in: GFM
// resolves a reference against the definitions in its OWN document, and the streaming
// pipeline hands the parser a committed prefix and a volatile tail as two documents.
// So the cases here need bodies built around that boundary, and they assert on the
// registry and the popover rather than on the paragraphs the sibling suite counts.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { FootnoteRegistry } from "./markdown/index.js";

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
  it("is a real reference and opens into the card's popover host", () => {
    render(
      <StreamingMarkdown
        publishedText={CROSS_BLOCK_FOOTNOTE}
        sourceId="event-30"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );

    // Parsed block-by-block with nothing else in scope, `[^1]` is literal text: no node,
    // no marker, no control. The whole body's definitions are restated ahead of each
    // block precisely so this marker exists to be pressed.
    const marker = screen.getByRole("button", { name: "Footnote 1" });
    fireEvent.click(marker);
    expect(screen.getByText("the note body")).toBeTruthy();
  });

  it("counts as a citation, so its definition is not reported uncited", () => {
    // The second symptom of the same defect: a reference that never became a node is a
    // reference the uncited walk cannot see, so the console accused the author of
    // leaving a note dangling under a message that cites it.
    const { container } = render(
      <StreamingMarkdown
        publishedText={CROSS_BLOCK_FOOTNOTE}
        sourceId="event-31"
        footnotes={new FootnoteRegistry()}
        isComplete
      />,
    );
    expect(container.textContent).not.toContain("Defined and never referred to");
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
