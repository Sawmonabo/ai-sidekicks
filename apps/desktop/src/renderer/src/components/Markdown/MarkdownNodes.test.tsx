import { act, cleanup, render } from "@testing-library/react";
import type { Root, Table } from "mdast";
import { afterEach, describe, expect, it } from "vitest";

import { DiagramPictures, DiagramPicturesContext } from "./diagram/pictures.js";
import { FakeDiagramWorkers } from "./diagram/worker/connection.test-support.js";
import type { CodeSpanReader } from "./highlight/code-span-reader.js";
import { MarkdownNodes } from "./MarkdownNodes.js";
import { piecedRowsOf } from "./parse/pieced-table.js";
import { MarkdownTrees, type MarkdownParseOutcome } from "./parse/trees.js";
import { parseTree } from "./parse/trees.test-support.js";
import type { MarkdownTableOffer } from "./table-offer.js";
import { MarkdownWorkerConnection } from "./worker/connection.js";
import { InThreadMarkdownWorkers } from "./worker/connection.test-support.js";

/** Leaves the renderer's caches alone: no case here shows enough pictures to empty them for. */
const keepUnusedMemory = (): void => undefined;

/** These documents hold no code block, so nothing may ask for colors. */
const NO_CODE_SPANS: CodeSpanReader = {
  heldSpans: () => {
    throw new Error("A document here asked for code colors.");
  },
  readSpans: () => {
    throw new Error("A document here asked for code colors.");
  },
};

async function renderMarkdown(source: string, isSettled = true): Promise<HTMLElement> {
  const tree = await parseTree(source);
  const { container } = render(
    <MarkdownNodes
      nodes={tree.children}
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
  it("renders as literal text, at block level", async () => {
    const container = await renderMarkdown("<div>hello</div>\n");
    expect(container.textContent).toContain("<div>hello</div>");
    expect(container.querySelector("div")).toBeNull();
  });

  it("renders as literal text, inline", async () => {
    const container = await renderMarkdown("before <b>bold</b> after\n");
    expect(container.textContent).toContain("<b>bold</b>");
    expect(container.querySelector("b")).toBeNull();
  });

  it("a script tag reaches the screen as characters", async () => {
    // The decision to run no sanitizer rests on this: nothing is parsed as markup.
    const container = await renderMarkdown("<script>alert(1)</script>\n");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("links", () => {
  it("keep their text and carry no anchor while the wire is unregistered", async () => {
    const container = await renderMarkdown("see [the file](./src/main.ts)\n");
    expect(container.textContent).toContain("the file");
    expect(container.querySelector("a")).toBeNull();
  });

  it("an autolink is inert too", async () => {
    const container = await renderMarkdown("<https://example.invalid/path>\n");
    expect(container.querySelector("a")).toBeNull();
  });
});

describe("images", () => {
  it("render their alt text and fetch nothing", async () => {
    const container = await renderMarkdown("![a diagram](https://example.invalid/x.png)\n");
    expect(container.textContent).toContain("a diagram");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("structure", () => {
  it("renders a footnote DEFINITION nowhere, so its text is not on screen twice", async () => {
    const container = await renderMarkdown("[^1]: the note body\n");
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
    const fenceTree = await parseTree(fence);
    const renderFence = (isSettled: boolean): HTMLElement =>
      render(
        <DiagramPicturesContext.Provider value={pictures}>
          <MarkdownNodes
            nodes={fenceTree.children}
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

describe("a long table offered to a body that draws its rows", () => {
  afterEach(() => {
    cleanup();
  });

  it("reads only the rows the body draws, so its pieces let go stay let go", () => {
    const workers = new InThreadMarkdownWorkers();
    // Room for about two pieces' trees, so the first pieces are let go as the last land.
    const trees = new MarkdownTrees(new MarkdownWorkerConnection(workers.start, window), 1_000_000);
    const rows = Array.from(
      { length: 5_000 },
      (_, index) => `| lane-${String(index)} | **${String(index)}** | \`code ${String(index)}\` |`,
    );
    let outcome: MarkdownParseOutcome | undefined;
    trees.requestTree(
      ["| Lane | State | Code |", "| --- | --- | --- |", ...rows].join("\n"),
      "",
      (landed) => {
        outcome = landed;
      },
    );
    const table = onlyTableOf(outcome?.status === "parsed" ? outcome.root : expect.fail("parsed"));
    const pieced = piecedRowsOf(table) ?? expect.fail("the table is read in pieces");
    const lastIndex = rows.length - 1;
    expect(pieced.isRowRead(0)).toBe(false);
    const parsedCount = workers.latest().requests.length;

    let offered: MarkdownTableOffer | undefined;
    const { container } = render(
      <MarkdownNodes
        nodes={[table]}
        context={{
          isSettled: true,
          definedFootnoteIdentifiers: new Set(),
          codeSpanReader: NO_CODE_SPANS,
          renderCopy: undefined,
          renderTable: (offer) => {
            offered = offer;
            return offer.drawFrame({
              columns: undefined,
              isShrunkToRoom: false,
              rowCount: undefined,
              headRow: offer.drawHeadRow({}),
              bodyRows: offer.drawBodyRow(lastIndex, {}),
            });
          },
        }}
      />,
    );

    expect(offered?.bodyRowCount).toBe(rows.length);
    expect(container.querySelectorAll("tr")).toHaveLength(2);
    expect(container.textContent).toContain(`lane-${String(lastIndex)}`);
    // No piece let go was read or parsed again to offer the table.
    expect(pieced.isRowRead(0)).toBe(false);
    expect(workers.latest().requests).toHaveLength(parsedCount);
  });
});

/** The one table a tree holds. */
function onlyTableOf(root: Root): Table {
  const [table] = root.children;
  return table?.type === "table" && root.children.length === 1
    ? table
    : expect.fail("the tree is one table");
}
