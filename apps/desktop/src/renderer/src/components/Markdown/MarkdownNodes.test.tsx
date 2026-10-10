import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { DiagramPictures, DiagramPicturesContext } from "./diagram/pictures.js";
import { FakeDiagramWorkers } from "./diagram/worker/connection.test-support.js";
import type { CodeSpanReader } from "./highlight/code-span-reader.js";
import { MarkdownNodes } from "./MarkdownNodes.js";
import { parseSettledBlock } from "./parse.js";

/** These documents hold no code block, so nothing may ask for colors. */
/** Leaves the renderer's caches alone: no case here shows enough pictures to empty them for. */
const keepUnusedMemory = (): void => undefined;

const NO_CODE_SPANS: CodeSpanReader = {
  heldSpans: () => {
    throw new Error("A document here asked for code colors.");
  },
  readSpans: () => {
    throw new Error("A document here asked for code colors.");
  },
};

function renderMarkdown(source: string, isSettled = true): HTMLElement {
  const { container } = render(
    <MarkdownNodes
      nodes={parseSettledBlock(source).children}
      context={{
        isSettled,
        definedFootnoteIdentifiers: new Set(),
        codeSpanReader: NO_CODE_SPANS,
        renderCopy: undefined,
        renderTable: undefined,
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

describe("a mermaid fence", () => {
  afterEach(() => {
    cleanup();
  });

  it("is a diagram block that asks for its picture once settled, and only then", async () => {
    const workers = new FakeDiagramWorkers();
    const pictures = new DiagramPictures(16 * 1024 * 1024, workers.start, keepUnusedMemory);
    const source = "flowchart LR\n  streamed --> settled";
    const fence = `\`\`\`mermaid\n${source}\n\`\`\`\n`;
    const renderFence = (isSettled: boolean): HTMLElement =>
      render(
        <DiagramPicturesContext.Provider value={pictures}>
          <MarkdownNodes
            nodes={parseSettledBlock(fence).children}
            context={{
              isSettled,
              definedFootnoteIdentifiers: new Set(),
              codeSpanReader: NO_CODE_SPANS,
              renderCopy: undefined,
              renderTable: undefined,
            }}
          />
        </DiagramPicturesContext.Provider>,
      ).container;

    const streaming = renderFence(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(streaming.querySelector(".meridian-diagram__source")?.textContent).toBe(source);
    expect(workers.started).toHaveLength(0);

    const settled = renderFence(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(settled.querySelector("figure.meridian-diagram")).not.toBeNull();
    expect(settled.querySelector(".meridian-code-block")).toBeNull();
    expect(workers.latest().requests.map((request) => request.source)).toStrictEqual([source]);
  });
});
