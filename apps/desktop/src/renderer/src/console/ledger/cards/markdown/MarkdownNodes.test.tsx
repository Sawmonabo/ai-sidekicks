// The mapper's three rules — and the one about HTML is the one that matters most.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownNodes } from "./MarkdownNodes.js";
import { parseSettledBlock } from "./markdown-parse.js";

function renderMarkdown(source: string, definedFootnotes: readonly string[] = []): HTMLElement {
  const { container } = render(
    <MarkdownNodes
      nodes={parseSettledBlock(source).children}
      context={{ isSettled: true, definedFootnoteIdentifiers: new Set(definedFootnotes) }}
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

  it("negative control: a script tag reaches the screen as characters", () => {
    // This is the assertion the whole no-sanitizer posture rests on. Nothing here is
    // ever parsed as markup, so there is nothing to sanitise — and if that ever stopped
    // being true, this case is what would say so.
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

  it("negative control: an autolink is inert too", () => {
    // Without this, a mapper that only handled the `[text](url)` form would leave the
    // autolink form clickable and the rule would hold for one spelling out of two.
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
  it("renders a heading as one element carrying its depth", () => {
    renderMarkdown("### A heading\n");
    const heading = screen.getByRole("heading");
    expect(heading.getAttribute("data-depth")).toBe("3");
    expect(heading.tagName).toBe("P");
  });

  it("renders a task list item as a disabled, read-only box", () => {
    const container = renderMarkdown("- [x] done\n");
    const checkbox = container.querySelector("input");
    expect(checkbox?.checked).toBe(true);
    expect(checkbox?.disabled).toBe(true);
    expect(checkbox?.readOnly).toBe(true);
  });

  it("renders a table inside its own scroll container", () => {
    const container = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |\n");
    expect(container.querySelector(".meridian-markdown__table-scroll")).not.toBeNull();
    expect(container.querySelectorAll("td").length).toBeGreaterThan(0);
  });

  it("renders a footnote reference and says whether its body arrived", () => {
    const withBody = renderMarkdown("cite[^1]\n\n[^1]: the note\n", ["1"]);
    expect(
      withBody.querySelector(".meridian-markdown__footnote")?.getAttribute("data-defined"),
    ).toBe("true");
    // The undefined arm is the STREAMING case: the block carrying the reference settled
    // before the block carrying its definition did, so the same parse yields a reference
    // node while the message's identifier set does not yet hold it. Passing an empty set
    // over the same source is exactly that state — a bare `[^2]` cannot produce it,
    // because GFM leaves an orphan reference as literal text rather than as a node.
    const withoutBody = renderMarkdown("cite[^1]\n\n[^1]: the note\n", []);
    expect(
      withoutBody.querySelector(".meridian-markdown__footnote")?.getAttribute("data-defined"),
    ).toBe("false");
  });

  it("renders a footnote DEFINITION nowhere, so its text is not on screen twice", () => {
    const container = renderMarkdown("[^1]: the note body\n");
    expect(container.textContent).not.toContain("the note body");
  });
});
