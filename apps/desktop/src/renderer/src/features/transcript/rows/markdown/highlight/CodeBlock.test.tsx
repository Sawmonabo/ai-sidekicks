// A code block is legible before it is coloured — and a volatile one is never coloured.

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CodeBlock } from "./CodeBlock.js";
import { CodeHighlightScheduler } from "./highlight-scheduler.js";

const schedulers: CodeHighlightScheduler[] = [];

function ownScheduler(): CodeHighlightScheduler {
  const created = new CodeHighlightScheduler();
  schedulers.push(created);
  return created;
}

afterEach(() => {
  for (const created of schedulers.splice(0)) {
    created.dispose();
  }
});

describe("a settled code block", () => {
  it("shows its source immediately, before any highlighting has run", () => {
    const { container } = render(
      <CodeBlock source="const a = 1;\n" infoString="ts" isSettled scheduler={ownScheduler()} />,
    );
    expect(container.textContent).toContain("const a = 1;");
  });

  it("swaps in spans whose colour is a family reference", async () => {
    const { container } = render(
      <CodeBlock source="const a = 1;" infoString="ts" isSettled scheduler={ownScheduler()} />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll(".meridian-code__line").length).toBeGreaterThan(0);
    });
    const styled = [...container.querySelectorAll("span[style]")];
    expect(styled.length).toBeGreaterThan(0);
    for (const span of styled) {
      expect(span.getAttribute("style")).toContain("var(--meridian-code-");
    }
  });

  it("negative control: a volatile block is never highlighted", () => {
    // Its text changes every frame, so each pass would be a cache miss whose tokens are
    // evicted before they are read again — and the colours would ripple as the grammar's
    // reading of an unfinished line changed under the reader.
    const { container } = render(
      <CodeBlock
        source="const a = 1;"
        infoString="ts"
        isSettled={false}
        scheduler={ownScheduler()}
      />,
    );
    expect(container.querySelectorAll(".meridian-code__line")).toHaveLength(0);
    expect(container.textContent).toContain("const a = 1;");
  });

  it("renders an unknown language as plain mono text rather than refusing", () => {
    const { container } = render(
      <CodeBlock
        source="?!? not a language"
        infoString="brainfuck"
        isSettled
        scheduler={ownScheduler()}
      />,
    );
    expect(container.textContent).toContain("?!? not a language");
    expect(container.querySelector(".meridian-code")).not.toBeNull();
  });

  it("carries the fence's info string wire-verbatim", () => {
    const { container } = render(
      <CodeBlock source="x" infoString="TypeScript" isSettled scheduler={ownScheduler()} />,
    );
    expect(container.querySelector(".meridian-code")?.getAttribute("data-language")).toBe(
      "TypeScript",
    );
  });
});
