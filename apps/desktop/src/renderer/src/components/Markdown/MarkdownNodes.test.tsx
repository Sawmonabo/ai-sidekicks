import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { CodeSpanReader } from "./highlight/code-span-reader.js";
import { MarkdownNodes } from "./MarkdownNodes.js";
import { parseSettledBlock } from "./parse/markdown-parse.js";

/** These documents hold no code block, so nothing may ask for colors. */
const NO_CODE_SPANS: CodeSpanReader = {
  heldSpans: () => {
    throw new Error("A document here asked for code colors.");
  },
  readSpans: () => {
    throw new Error("A document here asked for code colors.");
  },
};

function renderMarkdown(source: string, definedFootnotes: readonly string[] = []): HTMLElement {
  const { container } = render(
    <MarkdownNodes
      nodes={parseSettledBlock(source).children}
      context={{
        isSettled: true,
        definedFootnoteIdentifiers: new Set(definedFootnotes),
        codeSpanReader: NO_CODE_SPANS,
        renderCodeCopy: undefined,
      }}
    />,
  );
  return container;
}

describe("model HTML", () => {
  it("renders as literal text, at block level", () => {
    const container = renderMarkdown("<div>hello</div>\n");
    expect(container.textContent).toContain("<div>hello</div>");
    expect(container.querySelector("div")).toBeNull();
  });

  it("renders as literal text, inline", () => {
    const container = renderMarkdown("before <b>bold</b> after\n");
    expect(container.textContent).toContain("<b>bold</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  it("a script tag reaches the screen as characters", () => {
    // The decision to run no sanitizer rests on this: nothing is parsed as markup.
    const container = renderMarkdown("<script>alert(1)</script>\n");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("links", () => {
  it("keep their text and carry no anchor while the wire is unregistered", () => {
    const container = renderMarkdown("see [the file](./src/main.ts)\n");
    expect(container.textContent).toContain("the file");
    expect(container.querySelector("a")).toBeNull();
  });

  it("an autolink is inert too", () => {
    const container = renderMarkdown("<https://example.invalid/path>\n");
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("images", () => {
  it("render their alt text and fetch nothing", () => {
    const container = renderMarkdown("![a diagram](https://example.invalid/x.png)\n");
    expect(container.textContent).toContain("a diagram");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("structure", () => {
  it("renders a footnote DEFINITION nowhere, so its text is not on screen twice", () => {
    const container = renderMarkdown("[^1]: the note body\n");
    expect(container.textContent).not.toContain("the note body");
  });
});
