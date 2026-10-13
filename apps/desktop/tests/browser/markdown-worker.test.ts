// The markdown worker, started as the app starts it, on a page that is not cross-origin isolated,
// as the app's own documents are not: the parser's WebAssembly build makes its memory shared, which
// the platform allows without isolation as long as the memory never goes to another thread, so a
// tree it sends must be a plain buffer; if a later Chromium gates making shared memory too, this
// fails instead of every reply in the transcript. The worker makes the same HTML bytes the page
// makes from the tree it sends the page, on the constructs whose meaning reaches across a text:
// reference links and images, footnotes, a loose list beside a tight one, raw HTML and a table; and
// reads a drawn part into the same text as the page, as plain text, and as markdown with its HTML,
// a table's undrawn rows among it, and a text longer than one piece crosses whole. The page runs
// the module the worker compiled into the same tree the worker makes, and runs the compression
// module the worker compiles on its own, even beside a parser that fails to load, to pack a text's
// chunks and unpack them to the same text, and a held tree too long for the page into chunks,
// packed or kept plain where packing would not shrink them, that unpack to the same bytes and tree,
// while a shorter held tree stays as it came. The worker cuts a body into exactly the top-level
// blocks one parse of the whole body reads, whole and as it streams in, on the constructs a scan
// for blank lines cuts wrongly and on multibyte text, an emoji's halves either side of a window's
// edge among it; holding back one block instead of two splits a loose ordered list. A body no
// longer than a block the page parses is cut on the page, whole and as it streams in, at the ends
// the worker cuts, with no cut sent to the worker.

import { fromDom } from "hast-util-from-dom";
import type { Root } from "mdast";
import { materializeMdastTree } from "satteri/mdast-materializer";
import { MdastReader } from "satteri/mdast-reader";
import { expect, it, onTestFinished, vi } from "vitest";

import {
  drawnTreeMarkdown,
  drawnTreeText,
  markUndrawnRows,
  type DrawnElement,
  type DrawnTree,
} from "#renderer/components/Markdown/drawn-text.js";
import { markdownTreeToHtml } from "#renderer/components/Markdown/html.js";
import {
  BlockCut,
  MARKDOWN_SETTLE_LAG_BLOCKS,
  type TopLevelChildren,
} from "#renderer/components/Markdown/parse/block-cut.js";
import { definitionPreambleOf } from "#renderer/components/Markdown/parse/definition-preamble.js";
import { PackedTreeBuffer } from "#renderer/components/Markdown/parse/packed-tree-buffer.js";
import { PageParser } from "#renderer/components/Markdown/parse/page-parser.js";
import { loadMarkdownParserCalls } from "#renderer/components/Markdown/parse/parser-calls.js";
import {
  MarkdownTrees,
  PAGE_PARSE_MAX_CHARACTERS,
  type ParsedMarkdown,
} from "#renderer/components/Markdown/parse/trees.js";
import { parseTree } from "#renderer/components/Markdown/parse/trees.test-support.js";
import {
  MarkdownWorkerConnection,
  startMarkdownWorker,
  type MarkdownWorkerPort,
} from "#renderer/components/Markdown/worker/connection.js";
import type {
  MarkdownCutAnswer,
  MarkdownParseAnswer,
  MarkdownWorkerMessage,
  MarkdownWorkerReply,
} from "#renderer/components/Markdown/worker/messages.js";
import { longReplyMarkdown } from "#renderer/features/transcript/rows/bodies/WindowedMarkdown.test-support.js";
import { PACKED_CHUNK_MAX_BYTES, TextCompression } from "#renderer/lib/text/compression.js";
import { PackedText } from "#renderer/lib/text/packed.js";
import { TEXT_PIECE_LENGTH } from "#renderer/lib/text/pieces.js";
import { endWorkersWithTest } from "../helpers/worker-start.js";
import cutCases from "./markdown-cut-cases.json" with { type: "json" };

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

/** Lines of two-, three- and four-byte characters among ASCII, several packed chunks long. */
const MULTIBYTE_TEXT = Array.from(
  { length: 2_400 },
  (_, line) => `${String(line)}. Café — 漢字とかな 🙂 ok\n`,
).join("");

/** One paragraph of inline constructs, too long for the page to parse. */
const LONG_PARAGRAPH = `${Array.from({ length: 600 }, (_, index) => {
  const line = String(index);
  return (
    `Line ${line} has *emphasis*, \`code ${line}\`, ` +
    `[a link](https://example.org/${line}) and $x_${line}$.`
  );
}).join(" ")}\n`;

it("compiles the parser, and moves a tree to the page as a plain buffer", async () => {
  expect(globalThis.crossOriginIsolated).toBe(false);
  const worker = endWorkersWithTest(startMarkdownWorker)();
  const replies = repliesOf(worker);
  worker.postMessage({ kind: "load", parser: undefined, shouldCompileTextCompression: false });
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
  const { connection } = workerOnly();

  expect((await connection.html(REPLY)).text).toBe(markdownTreeToHtml(await parseTree(REPLY)));
  expect((await connection.html(LONG_REPLY)).text).toBe(
    markdownTreeToHtml(await parseTree(LONG_REPLY)),
  );
});

it("reads a drawn part into the same text and HTML off the page's thread as on it", async () => {
  const { connection } = workerOnly();
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

it("parses a block on the page, from the worker's module, into the same tree the worker makes", async () => {
  const { trees } = await pageAndWorker();
  const preamble = definitionPreambleOf(new Set(["first", "second"]), []);

  const onWorker = await settledBlockOf(trees, REPLY, preamble);
  const onPage = trees.parseSettledBlockNow(REPLY, preamble) ?? expect.fail("parsed on the page");

  expect(plainTreeOf(onPage.root)).toStrictEqual(plainTreeOf(onWorker.root));
  expect(onPage.root.children.map((node) => node.type)).toContain("table");
});

it("packs and unpacks a chunk on the page with the worker's compression module", async () => {
  const textCompression = new TextCompression(window);
  const connection = new MarkdownWorkerConnection(
    endWorkersWithTest(startMarkdownWorker),
    window,
    new PageParser(loadMarkdownParserCalls),
    textCompression,
  );
  connection.wake();
  await vi.waitFor(() => {
    expect(textCompression.state).toBe("provided");
  });

  // A full chunk of whole multibyte characters, cut where the next one would not fit.
  const plain = new Uint8Array(PACKED_CHUNK_MAX_BYTES);
  const { written } = new TextEncoder().encodeInto(MULTIBYTE_TEXT, plain);
  const chunk = plain.slice(0, written);
  const packed = textCompression.pack(chunk) ?? expect.fail("the chunk packs smaller");
  expect(textCompression.state).toBe("running");
  expect(packed.byteLength).toBeLessThan(chunk.byteLength);
  expect(textCompression.decode(packed, chunk.byteLength, true)).toBe(
    new TextDecoder().decode(chunk),
  );

  // A text of several chunks packs each at an idle moment and reads back exactly, unpacked.
  const packing = vi.spyOn(textCompression, "pack");
  const text = PackedText.of(MULTIBYTE_TEXT, textCompression);
  const chunkCount = Math.ceil(text.byteLength / PACKED_CHUNK_MAX_BYTES);
  await vi.waitFor(() => {
    expect(packing.mock.calls.length).toBeGreaterThanOrEqual(chunkCount);
  });
  expect(packing.mock.results.every((result) => result.value instanceof Uint8Array)).toBe(true);
  expect([...text.chunks()].join("")).toBe(MULTIBYTE_TEXT);
  expect(text.slice(PACKED_CHUNK_MAX_BYTES - 7, PACKED_CHUNK_MAX_BYTES * 3)).toBe(
    MULTIBYTE_TEXT.slice(PACKED_CHUNK_MAX_BYTES - 7, PACKED_CHUNK_MAX_BYTES * 3),
  );
});

it("packs a held tree too long for the page, and reads it back as the same tree", async () => {
  const { connection, trees } = await pageAndWorker();
  const compression = connection.textCompression;
  await vi.waitFor(() => {
    expect(compression.state).toBe("provided");
  });

  // Held by size: the long block's tree is packed at an idle moment, the short one's never.
  const short = await heldTreeOf(trees, "A paragraph short enough for the page.\n");
  const long = await heldTreeOf(trees, LONG_PARAGRAPH);
  await vi.waitFor(() => {
    expect(long.tree.treeByteCount).toBeLessThan(long.landedByteCount / 2);
  });
  expect(short.tree.treeByteCount).toBe(short.landedByteCount);

  // A chunk at a time, the whole buffer is held until every chunk is offered; read back, the bytes
  // and the tree they make are the ones the worker sent.
  const answer = await new Promise<MarkdownParseAnswer>((resolve) => {
    connection.parse(LONG_PARAGRAPH, resolve);
  });
  const sent = answer.status === "parsed" ? answer.buffer : expect.fail(JSON.stringify(answer));
  const packed = new PackedTreeBuffer(sent.slice(0), compression);
  expect(packed.packWhile(() => false)).toBe(false);
  expect(packed.heldByteCount).toBeGreaterThan(sent.byteLength);
  expect(packed.packWhile(() => true)).toBe(true);
  expect(packed.heldByteCount).toBeLessThan(sent.byteLength / 2);
  const read = packed.read();
  expect(new Uint8Array(read)).toStrictEqual(new Uint8Array(sent));
  expect(materializeMdastTree(new MdastReader(read))).toStrictEqual(
    materializeMdastTree(new MdastReader(sent)),
  );

  // Bytes that pack no smaller are kept plain, and read back as they came.
  const noise = crypto.getRandomValues(new Uint8Array(PACKED_CHUNK_MAX_BYTES + 3_000));
  const kept = new PackedTreeBuffer(noise.slice().buffer, compression);
  expect(kept.packWhile(() => true)).toBe(true);
  expect(kept.heldByteCount).toBe(noise.byteLength);
  expect(new Uint8Array(kept.read())).toStrictEqual(noise);
});

it("compiles the compression module apart from a parser that fails to load", async () => {
  const worker = endWorkersWithTest(startMarkdownWorker)();
  const replies = repliesOf(worker);
  // A module with nothing in it, which the parser's loader cannot run.
  const emptyModule = new WebAssembly.Module(
    new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  );
  worker.postMessage({ kind: "load", parser: emptyModule, shouldCompileTextCompression: true });

  const heard = [await replies.next(), await replies.next()];
  expect(heard.map((reply) => reply.status).sort()).toStrictEqual([
    "load-failed",
    "text-compression",
  ]);
  const codec = heard.find((reply) => reply.status === "text-compression");
  expect(codec?.status === "text-compression" && codec.textCompression.status).toBe("compiled");
});

it("cuts a body into the top-level blocks one parse of the whole body reads", async () => {
  const { connection, pageParser } = await pageAndWorker();
  for (const [name, text] of Object.entries(CUT_TEXTS)) {
    const blockEnds = await new Promise<readonly number[]>((resolve, reject) => {
      connection.cut(text, true, (answer) => {
        if (answer.status === "failed") {
          reject(new Error(answer.reason));
          return;
        }
        resolve([...answer.blockEnds]);
      });
    });
    expect(blockEnds, name).toStrictEqual(wholeParseBlockEndsOf(pageParser, text));
  }
});

it("cuts a streaming body into the same blocks as it grows, holding back two blocks", async () => {
  const { pageParser } = await pageAndWorker();
  const readChildren = await childrenReaderOnPage();
  for (const [name, text] of Object.entries(CUT_TEXTS)) {
    const appendLength = seededAppendLengths(name.length);
    expect(
      streamedBlockEndsOf(text, MARKDOWN_SETTLE_LAG_BLOCKS, readChildren, appendLength),
      name,
    ).toStrictEqual(wholeParseBlockEndsOf(pageParser, text));
  }
  // Holding back one block freezes a loose ordered list before its third item arrives.
  const looseList = "Intro.\n\n1. one\n\n2. two, loose\n\n3. three\n\nAfter.\n";
  expect(streamedBlockEndsOf(looseList, 1, readChildren, () => 1)).not.toStrictEqual(
    wholeParseBlockEndsOf(pageParser, looseList),
  );
  expect(
    streamedBlockEndsOf(looseList, MARKDOWN_SETTLE_LAG_BLOCKS, readChildren, () => 1),
  ).toStrictEqual(wholeParseBlockEndsOf(pageParser, looseList));
});

it("cuts a body no longer than a page-parsed block on the page, where the worker cuts it", async () => {
  const { connection, trees, sentKinds } = await pageAndWorker();
  const texts: Record<string, string> = {
    ...cutCases,
    "a long reply under the cap": longReplyMarkdown(PAGE_PARSE_MAX_CHARACTERS - 4_000),
  };
  const pageCuts: { name: string; source: string; isFinal: boolean; blockEnds: number[] }[] = [];
  const cutOnPage = async (name: string, source: string, isFinal: boolean): Promise<number[]> => {
    expect(source.length, name).toBeLessThanOrEqual(PAGE_PARSE_MAX_CHARACTERS);
    const blockEnds = await blockEndsOf(trees.requestCut.bind(trees), source, isFinal);
    pageCuts.push({ name, source, isFinal, blockEnds });
    return blockEnds;
  };
  for (const [name, text] of Object.entries(texts)) {
    await cutOnPage(name, text, true);
    // Streamed: the text past the blocks cut so far, cut again after each append.
    const appendLength = seededAppendLengths(name.length);
    let cutEnd = 0;
    let received = 0;
    while (received < text.length) {
      received = Math.min(text.length, received + appendLength());
      const blockEnds = await cutOnPage(
        name,
        text.slice(cutEnd, received),
        received === text.length,
      );
      cutEnd += blockEnds.at(-1) ?? 0;
    }
  }

  expect(sentKinds).not.toContain("cut");
  for (const { name, source, isFinal, blockEnds } of pageCuts) {
    expect(blockEnds, name).toStrictEqual(
      await blockEndsOf(connection.cut.bind(connection), source, isFinal),
    );
  }
});

/**
 * `MULTIBYTE_TEXT`'s lines as paragraphs, so a block starts after each line's multibyte text, where
 * an offset in UTF-8 bytes would run past the line the block starts on.
 */
const MULTIBYTE_PARAGRAPHS = MULTIBYTE_TEXT.replaceAll(/^\d+\. /gmu, "").replaceAll("\n", "\n\n");

/**
 * ASCII paragraphs up to a line whose emoji has its two halves either side of 65,536 code units,
 * where the cut's first window would end were it not cut back to whole lines.
 */
const EMOJI_AT_WINDOW_EDGE = ((): string => {
  const paragraphs = `${"a".repeat(99)}\n\n`.repeat(648);
  const lead = "b".repeat(65_535 - paragraphs.length);
  return `${paragraphs}${lead}\u{1F600} after the edge\n\n${"c".repeat(40)}\n\n- an item\n`;
})();

/**
 * The hand cases a scan for blank lines cuts wrongly, a long reply of every kind of block, and
 * multibyte text, whose code units and UTF-8 bytes place each block apart.
 */
const CUT_TEXTS: Readonly<Record<string, string>> = {
  ...cutCases,
  "a long reply": longReplyMarkdown(80_000),
  "multibyte lines": MULTIBYTE_TEXT,
  "multibyte paragraphs": MULTIBYTE_PARAGRAPHS,
  "an emoji across a window's edge": EMOJI_AT_WINDOW_EDGE,
};

/** A connection to a markdown worker, whose page parser is never started. */
function workerOnly(): { readonly connection: MarkdownWorkerConnection } {
  return {
    connection: new MarkdownWorkerConnection(
      endWorkersWithTest(startMarkdownWorker),
      window,
      new PageParser(loadMarkdownParserCalls),
      new TextCompression(window),
    ),
  };
}

/**
 * A markdown worker and a page parser of the test's own, started as the app starts it: the
 * connection hands the module the worker compiled to the page in an idle moment. `sentKinds` lists
 * the kind of each message the page sends a worker.
 */
async function pageAndWorker(): Promise<{
  readonly connection: MarkdownWorkerConnection;
  readonly pageParser: PageParser;
  readonly trees: MarkdownTrees;
  readonly sentKinds: readonly MarkdownWorkerMessage["kind"][];
}> {
  const sentKinds: MarkdownWorkerMessage["kind"][] = [];
  const start = endWorkersWithTest(startMarkdownWorker);
  const pageParser = new PageParser(loadMarkdownParserCalls);
  const connection = new MarkdownWorkerConnection(
    () => {
      const port = start();
      const post = port.postMessage.bind(port);
      port.postMessage = (message, transfer = []) => {
        sentKinds.push(message.kind);
        post(message, transfer);
      };
      return port;
    },
    window,
    pageParser,
    new TextCompression(window),
  );
  const trees = new MarkdownTrees(connection);
  trees.wakeWorker();
  await vi.waitFor(
    () => {
      expect(pageParser.state).toBe("ready");
    },
    { timeout: 10_000 },
  );
  return { connection, pageParser, trees, sentKinds };
}

/** Where `cut` says the blocks of `source` end, its last ones too when `isFinal`. */
async function blockEndsOf(
  cut: (source: string, isFinal: boolean, listener: (answer: MarkdownCutAnswer) => void) => unknown,
  source: string,
  isFinal: boolean,
): Promise<number[]> {
  return await new Promise((resolve, reject) => {
    cut(source, isFinal, (answer) => {
      if (answer.status === "failed") {
        reject(new Error(answer.reason));
        return;
      }
      resolve([...answer.blockEnds]);
    });
  });
}

/** The top-level children reader, loaded on the page once a started page parser set its module. */
async function childrenReaderOnPage(): Promise<(window: string) => TopLevelChildren> {
  const { readTopLevelChildren } =
    await import("#renderer/components/Markdown/parse/top-level-children.js");
  return readTopLevelChildren;
}

/** A settled block's tree from the worker, against `preamble`. */
async function settledBlockOf(
  trees: MarkdownTrees,
  source: string,
  preamble: string,
): Promise<ParsedMarkdown> {
  return await new Promise((resolve, reject) => {
    trees.requestSettledBlock(source, preamble, (outcome) => {
      if (outcome.status === "failed") {
        reject(new Error(outcome.reason));
        return;
      }
      resolve(outcome);
    });
  });
}

/** A settled block's tree held in `trees`, and what it kept as it landed, in bytes. */
async function heldTreeOf(
  trees: MarkdownTrees,
  source: string,
): Promise<{ readonly tree: ParsedMarkdown; readonly landedByteCount: number }> {
  const tree = await new Promise<ParsedMarkdown>((resolve, reject) => {
    const letGo = trees.holdSettledBlock(source, "", (outcome) => {
      if (outcome.status === "failed") {
        reject(new Error(outcome.reason));
        return;
      }
      resolve(outcome);
    });
    onTestFinished(letGo);
  });
  return { tree, landedByteCount: tree.treeByteCount };
}

/** A tree's nodes as plain data, without a table's mark of its pieces. */
function plainTreeOf(root: Root): unknown {
  return JSON.parse(
    JSON.stringify(root.children, (key, value: unknown) => (key === "data" ? undefined : value)),
  );
}

/**
 * Where each block of `text` ends as one parse of the whole text reads its top-level children: the
 * first starts at the text's start, each next one at the start of its child's first line, and the
 * last runs to the text's end.
 */
function wholeParseBlockEndsOf(pageParser: PageParser, text: string): number[] {
  const children = pageParser.parse(text).children;
  const ends = children.slice(1).map((child) => {
    const offset = child.position?.start.offset ?? expect.fail("a top-level child has a position");
    return text.lastIndexOf("\n", offset - 1) + 1;
  });
  return children.length === 0 ? [] : [...ends, text.length];
}

/**
 * Where each block of `text` ends as a body streaming it in appends of `appendLength` characters
 * cuts it: the text past the blocks cut so far, cut again after each append holding back
 * `lagBlocks`, then cut whole once it is all in.
 */
function streamedBlockEndsOf(
  text: string,
  lagBlocks: number,
  readChildren: (window: string) => TopLevelChildren,
  appendLength: () => number,
): number[] {
  const blockEnds: number[] = [];
  let received = 0;
  while (received < text.length) {
    received = Math.min(text.length, received + appendLength());
    const from = blockEnds.at(-1) ?? 0;
    const cut = new BlockCut(
      text.slice(from, received),
      received === text.length,
      lagBlocks,
      readChildren,
    );
    for (const end of cut.cutWhole()) {
      blockEnds.push(from + end);
    }
  }
  return blockEnds;
}

/** Append lengths of 1 to 200 characters, the same for the same seed. */
function seededAppendLengths(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return 1 + (state % 200);
  };
}

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
