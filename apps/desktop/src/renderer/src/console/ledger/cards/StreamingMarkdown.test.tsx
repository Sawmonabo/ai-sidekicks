// The pipeline, mounted — and the one property the split exists for.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StreamingMarkdown } from "./StreamingMarkdown.js";
import { FootnoteRegistry } from "./markdown/index.js";

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
