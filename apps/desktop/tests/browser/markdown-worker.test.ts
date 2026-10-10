// The markdown worker, started as the app starts it, makes the same HTML bytes the page makes on
// its own thread, on the constructs whose meaning reaches across a text: reference links and
// images, footnotes, a loose list beside a tight one, raw HTML and a table; and reads a drawn part
// into the same text as the page, as markdown and as plain text, a table's undrawn rows among it.

import { fromDom } from "hast-util-from-dom";
import { expect, it } from "vitest";

import { drawnTreeText } from "#renderer/components/Markdown/drawn-text.js";
import { markdownToHtml } from "#renderer/components/Markdown/html.js";
import {
  MarkdownWorkerConnection,
  startMarkdownWorker,
} from "#renderer/components/Markdown/worker/connection.js";

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

it("makes the same HTML bytes off the page's thread as on it", async () => {
  const connection = new MarkdownWorkerConnection(startMarkdownWorker);

  expect(await connection.html(REPLY)).toBe(markdownToHtml(REPLY));
});

it("reads a drawn part into the same text off the page's thread as on it, in both flavors", async () => {
  const connection = new MarkdownWorkerConnection(startMarkdownWorker);
  const drawing = document.createElement("div");
  drawing.innerHTML =
    '<p role="heading" aria-level="2">Findings</p>' +
    "<ul><li data-spread>a loose item</li><li>its neighbor</li></ul>" +
    '<pre data-language="ts"><code>const answer = 42;</code></pre>' +
    '<table><thead><tr><th data-align="left">Lane</th><th data-align="right">Rows</th></tr>' +
    '</thead><tbody><tr><td data-align="left">Architect</td><td data-align="right">412</td></tr>' +
    "<tr></tr></tbody></table>";
  const tree = fromDom(drawing);
  const undrawnRow = drawing.querySelectorAll("tr")[2];
  // The last row stands for rows the screen did not draw, holding their markdown.
  undrawnRow?.setAttribute(
    "data-undrawn-rows-markdown",
    "| | |\n| --- | --- |\n| **Builder** with `code` | [7](https://example.com) |\n| <b>raw</b> | ~~gone~~ |",
  );
  const treeWithUndrawnRows = fromDom(drawing);

  for (const flavor of ["markdown", "text"] as const) {
    expect(await connection.drawnText(treeWithUndrawnRows, flavor)).toBe(
      drawnTreeText(structuredClone(treeWithUndrawnRows), flavor),
    );
  }
  expect(drawnTreeText(structuredClone(treeWithUndrawnRows), "markdown")).toContain("Builder");
  expect(drawnTreeText(tree, "markdown")).not.toContain("Builder");
});
