// The markdown worker, started as the app starts it, makes the same HTML bytes the page makes on
// its own thread, on the constructs whose meaning reaches across a text: reference links and
// images, footnotes, a loose list beside a tight one, raw HTML and a table; and reads a drawn part
// into the same text as the page, as markdown and as plain text, a table's undrawn rows among it,
// and a text longer than one piece crosses whole.

import { fromDom } from "hast-util-from-dom";
import { expect, it } from "vitest";

import {
  drawnTreeText,
  markUndrawnRows,
  type DrawnElement,
  type DrawnTree,
} from "#renderer/components/Markdown/drawn-text.js";
import { markdownToHtml } from "#renderer/components/Markdown/html.js";
import {
  MarkdownWorkerConnection,
  startMarkdownWorker,
} from "#renderer/components/Markdown/worker/connection.js";
import { TEXT_PIECE_LENGTH } from "#renderer/lib/text-pieces.js";

/** A reply whose parts each read something defined elsewhere in it, or as markup. */
const REPLY = [
  "# Findings",
  "",
  "See [the reader][reader] and ![its diagram][figure], noted twice.[^first] Again.[^second]",
  "",
  "- a loose item",
  "",
  "- another, after a blank line",
  "",
  "1. a tight item",
  "2. and its neighbor",
  "",
  '<div class="raw">raw markup stays text</div>',
  "",
  "| Lane | Rows |",
  "| --- | ---: |",
  "| Architect | 412 |",
  "",
  "[reader]: https://example.com/reader 'The reader'",
  "[figure]: https://example.com/figure.png",
  "",
  "[^first]: The first note.",
  "[^second]: The second, with **strong** text.",
].join("\n");

/**
 * A reply longer than one piece of text, an emoji's two halves either side of where a piece would
 * end, so the bytes cross between pieces as the page and the worker cut them.
 */
const LONG_REPLY = `${"a".repeat(TEXT_PIECE_LENGTH - 1)}\u{1F600} and ${REPLY}`;

it("makes the same HTML bytes off the page's thread as on it", async () => {
  const connection = new MarkdownWorkerConnection(startMarkdownWorker, window);

  expect(await connection.html(REPLY)).toBe(markdownToHtml(REPLY));
  expect(await connection.html(LONG_REPLY)).toBe(markdownToHtml(LONG_REPLY));
});

it("reads a drawn part into the same text off the page's thread as on it, in both flavors", async () => {
  const connection = new MarkdownWorkerConnection(startMarkdownWorker, window);
  const drawing = document.createElement("div");
  drawing.innerHTML =
    '<p role="heading" aria-level="2">Findings</p>' +
    "<ul><li data-spread>a loose item</li><li>its neighbor</li></ul>" +
    '<pre data-language="ts"><code>const answer = 42;</code></pre>' +
    '<table><thead><tr><th data-align="left">Lane</th><th data-align="right">Rows</th></tr>' +
    '</thead><tbody><tr><td data-align="left">Architect</td><td data-align="right">412</td></tr>' +
    "<tr></tr></tbody></table>";
  const tree = fromDom(drawing);
  // The last row stands for the rows the screen did not draw, read from the table's block.
  const undrawnRow = elementsOf(tree, "tr")[2] ?? expect.fail("the table draws three rows");
  markUndrawnRows(undrawnRow, { tableKey: "table", tableStart: 0, firstIndex: 1, lastIndex: 2 });
  const blockSources = new Map([
    [
      "table",
      {
        source: [
          "| Lane | Rows |",
          "| :-- | --: |",
          "| Architect | 412 |",
          "| **Builder** with `code` | [7](https://example.com) |",
          "| <b>raw</b> | ~~gone~~ |",
        ].join("\n"),
        definitionPreamble: "",
        isVolatileTail: false,
      },
    ],
  ]);

  for (const flavor of ["markdown", "text"] as const) {
    const onPage = drawnTreeText(structuredClone(tree), flavor, (tableKey) =>
      blockSources.get(tableKey),
    );
    const made = await connection.drawnText(tree, flavor, blockSources);
    expect(made.text).toBe(onPage);
    expect(onPage).toContain("Builder");
  }
});

/** The elements of `tree` named `tagName`, in document order. */
function elementsOf(tree: DrawnTree, tagName: string): DrawnElement[] {
  if (!("children" in tree)) {
    return [];
  }
  return tree.children.flatMap((child) =>
    child.type === "element"
      ? [...(child.tagName === tagName ? [child] : []), ...elementsOf(child, tagName)]
      : [],
  );
}
