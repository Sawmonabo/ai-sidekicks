// The markdown worker, started as the app starts it, on a page that is not cross-origin isolated,
// as the app's own documents are not: the parser's WebAssembly build makes its memory shared, which
// the platform allows without isolation as long as the memory never goes to another thread, so a
// tree it sends must be a plain buffer; if a later Chromium gates making shared memory too, this
// fails instead of every reply in the transcript. The worker makes the same HTML bytes the page
// makes from the tree it sends the page, on the constructs whose meaning reaches across a text:
// reference links and images, footnotes, a loose list beside a tight one, raw HTML and a table;
// and reads a drawn part into the same text as the page, as plain text, and as markdown with its
// HTML, a table's undrawn rows among it, and a text longer than one piece crosses whole.

import { fromDom } from "hast-util-from-dom";
import { materializeMdastTree } from "satteri/mdast-materializer";
import { MdastReader } from "satteri/mdast-reader";
import { expect, it } from "vitest";

import {
  drawnTreeMarkdown,
  drawnTreeText,
  markUndrawnRows,
  type DrawnElement,
  type DrawnTree,
} from "#renderer/components/Markdown/drawn-text.js";
import { markdownTreeToHtml } from "#renderer/components/Markdown/html.js";
import { parseTree } from "#renderer/components/Markdown/parse/trees.test-support.js";
import {
  MarkdownWorkerConnection,
  startMarkdownWorker,
  type MarkdownWorkerPort,
} from "#renderer/components/Markdown/worker/connection.js";
import type { MarkdownWorkerReply } from "#renderer/components/Markdown/worker/messages.js";
import { TEXT_PIECE_LENGTH } from "#renderer/lib/text-pieces.js";
import { endWorkersWithTest } from "../helpers/worker-start.js";

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

it("compiles the parser, and moves a tree to the page as a plain buffer", async () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
  const worker = endWorkersWithTest(startMarkdownWorker)();
  const replies = repliesOf(worker);
  worker.postMessage({ kind: "load", parser: undefined });
  worker.postMessage({
    kind: "parse",
    requestId: 1,
    source: "# Lanes\n\n| Lane | Rows |\n| --- | ---: |\n| Architect | 412 |\n",
  });

  expect((await replies.next()).status).toBe("compiled");
  const reply = await replies.next();
  const tree = reply.status === "parsed" ? reply.trees[0] : expect.fail(JSON.stringify(reply));
  expect(Object.prototype.toString.call(tree?.buffer)).toBe("[object ArrayBuffer]");
  const root = materializeMdastTree(new MdastReader(tree?.buffer ?? expect.fail("a tree")));
  expect(root.children.map((node) => node.type)).toStrictEqual(["heading", "table"]);
});

it("makes the same HTML bytes off the page's thread as the page makes from the tree it sends", async () => {
  const connection = new MarkdownWorkerConnection(endWorkersWithTest(startMarkdownWorker), window);

  expect((await connection.html(REPLY)).text).toBe(markdownTreeToHtml(await parseTree(REPLY)));
  expect((await connection.html(LONG_REPLY)).text).toBe(
    markdownTreeToHtml(await parseTree(LONG_REPLY)),
  );
});

it("reads a drawn part into the same text and HTML off the page's thread as on it", async () => {
  const connection = new MarkdownWorkerConnection(endWorkersWithTest(startMarkdownWorker), window);
  const drawing = document.createElement("div");
  drawing.innerHTML =
    '<p role="heading" aria-level="2">Findings</p>' +
    "<ul><li data-spread>a loose item</li><li>its neighbor</li></ul>" +
    '<pre data-language="ts"><code>const answer = 42;</code></pre>' +
    '<table><thead><tr><th data-align="left">Lane</th><th data-align="right">Rows</th></tr>' +
    '</thead><tbody><tr><td data-align="left">Architect</td><td data-align="right">412</td></tr>' +
    "<tr></tr></tbody></table>";
  const tree = fromDom(drawing);
  const asText = await connection.drawnText(structuredClone(tree), "text", new Map());
  expect(asText).toStrictEqual({
    text: { text: drawnTreeText(tree, "text"), pieces: [asText.text.text] },
  });
  // The last row stands for the rows the screen did not draw, read from the table's parse.
  const undrawnRow = elementsOf(tree, "tr")[2] ?? expect.fail("the table draws three rows");
  markUndrawnRows(undrawnRow, { tableKey: "table", firstIndex: 1, lastIndex: 2 });
  const [table] = (
    await parseTree(
      [
        "| Lane | Rows |",
        "| :-- | --: |",
        "| Architect | 412 |",
        "| **Builder** with `code` | [7](https://example.com) |",
        "| <b>raw</b> | ~~gone~~ |",
      ].join("\n"),
    )
  ).children;
  if (table?.type !== "table") {
    return expect.fail("the markdown makes a table");
  }

  const onPage = await drawnTreeMarkdownOnPage(tree, {
    alignments: new Map([["table", table.align]]),
    pull: async (_tableKey, firstIndex, lastIndex) =>
      table.children.slice(firstIndex + 1, lastIndex + 2),
  });
  const made = await connection.drawnText(tree, "markdown", new Map([["table", table]]));
  expect(made.text.text).toBe(onPage.markdown.join(""));
  expect(made.html?.text).toBe(onPage.html.join(""));
  expect(made.text.text).toContain("Builder");
});

/** The replies `worker` sends, each read in turn. */
function repliesOf(worker: MarkdownWorkerPort): {
  readonly next: () => Promise<MarkdownWorkerReply>;
} {
  const heard: MarkdownWorkerReply[] = [];
  let wake: (() => void) | undefined;
  worker.onmessage = (event) => {
    heard.push(event.data);
    wake?.();
  };
  return {
    next: async () => {
      while (heard.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return heard.shift() ?? expect.fail("a reply was heard");
    },
  };
}

/** Stops a read of a drawn part at its parse, carrying the markdown it was to parse. */
class MarkdownWritten extends Error {
  public readonly markdown: string;

  public constructor(markdown: string) {
    super("The drawn part's markdown was written");
    this.markdown = markdown;
  }
}

/**
 * What `drawnTreeMarkdown` reads `tree` into on the page, which parses only through the worker:
 * read up to its parse for the markdown it writes, which the worker parses, then read again with
 * that tree for its HTML.
 */
async function drawnTreeMarkdownOnPage(
  tree: DrawnTree,
  undrawnRows: Parameters<typeof drawnTreeMarkdown>[1],
): ReturnType<typeof drawnTreeMarkdown> {
  const written = await drawnTreeMarkdown(structuredClone(tree), undrawnRows, (markdown) => {
    throw new MarkdownWritten(markdown);
  }).then(
    () => expect.fail("the read stops at its parse"),
    (stop: unknown) => (stop instanceof MarkdownWritten ? stop.markdown : Promise.reject(stop)),
  );
  const root = await parseTree(written);
  return await drawnTreeMarkdown(structuredClone(tree), undrawnRows, () => root);
}

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
