// The markdown worker, started as the app starts it, makes the same HTML bytes the page makes on
// its own thread, on the constructs whose meaning reaches across a text: reference links and
// images, footnotes, a loose list beside a tight one, raw HTML and a table.

import { expect, it } from "vitest";

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
