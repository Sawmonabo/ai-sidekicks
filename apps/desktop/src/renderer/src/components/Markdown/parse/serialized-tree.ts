// One markdown text parsed by Sätteri into its binary tree, or into the tree the screen draws, with
// the features the app draws: GFM (tables, task lists, strikethrough, footnotes, autolinks) and
// math between dollars, and no front matter. A formula between single dollars keeps Pandoc's rule
// (`math-syntax.ts`): where the parser reads one that breaks it, the opening dollar becomes a
// stand-in character the parse reads as text and the text is parsed again, so the words after it
// read as they would with no formula there. Both threads load it: the markdown worker, and the
// page, which parses a block as it mounts, each from the module the worker compiled.

import type { Root } from "mdast";
import { createMdastHandle, dropHandle, serializeHandle, type Features } from "satteri";
import { MdastReader, NodeType } from "satteri/mdast-reader";

import { isPandocFormula } from "../math-syntax.js";
import { materializeMarkdownTree } from "./materialized-tree.js";

/** One text's tree as the worker sends it: its buffer, and the stand-in its dollars took, if any. */
export interface SerializedTree {
  readonly buffer: ArrayBuffer;
  readonly dollarStandIn: string | undefined;
}

/**
 * The parser's features. Front matter is off because a reply opening on `---` is a thematic break
 * and a heading, as commonmark reads it. The parser pairs single tildes as strikethrough and makes
 * a few literal autolinks GFM does not, which the page undoes when it reads the tree.
 */
export const MARKDOWN_FEATURES: Features = { gfm: true, frontmatter: false, math: true };

/**
 * What can stand in for a dollar the parse must read as text: a symbol, as a dollar is, so emphasis
 * beside one reads the same; one UTF-16 unit, as a dollar is, so no offset moves; and not ASCII,
 * so none is markdown syntax. The first the text does not hold is used, so every one in the tree
 * is a stand-in.
 */
const DOLLAR_STAND_IN = /^\p{S}$/u;

/** Where the stand-ins are looked for: past ASCII, through the basic multilingual plane. */
const FIRST_STAND_IN_CODE = 0xa1;
const LAST_STAND_IN_CODE = 0xffff;

/**
 * A short reply touching the paths replies take through the parser: headings, emphasis, a link, a
 * list, a task, a quote, a fence, a table, a formula and a footnote. WebAssembly compiles each
 * function the first time it runs, so parsing this once as the parser loads moves that compiling
 * off the first reply the person waits on; the compiled code belongs to the module the app keeps.
 */
const WARM_UP_TEXT = [
  "# Heading",
  "",
  "Prose with *emphasis*, **strong**, `code`, ~~struck~~, $x^2$, a [link](https://example.com)",
  "and a note.[^1] It costs $5 and $10.",
  "",
  "- [x] A task",
  "- An item",
  "  1. Nested",
  "",
  "> A quote",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "| Lane | Rows |",
  "| --- | ---: |",
  "| Architect | 412 |",
  "",
  "[^1]: The note.",
  "",
].join("\n");

/**
 * `source` parsed, positions included, as a buffer the page can take whole. A NUL becomes U+FFFD
 * first, as commonmark requires, and each dollar read as text a stand-in; neither moves an offset.
 * A text holding every stand-in keeps the formulas the parser reads.
 */
export function serializeMarkdownTree(source: string): SerializedTree {
  let parsedText = withoutNul(source);
  let dollarStandIn: string | undefined;
  for (;;) {
    const bytes = serializedBytesOf(parsedText);
    const refusedOpeners = parsedText.includes("$") ? refusedFormulaOpeners(bytes, parsedText) : [];
    dollarStandIn ??= refusedOpeners.length === 0 ? undefined : standInFor(parsedText);
    if (dollarStandIn === undefined || refusedOpeners.length === 0) {
      return { buffer: standaloneBufferOf(bytes), dollarStandIn };
    }
    parsedText = withStandIns(parsedText, refusedOpeners, dollarStandIn);
  }
}

/**
 * `source` as the parser reads it: each NUL replaced by U+FFFD, as commonmark requires, which moves
 * no offset.
 */
export function withoutNul(source: string): string {
  return source.replaceAll("\u0000", "\uFFFD");
}

/**
 * Parses a short reply touching every path a reply takes through the parser, on the thread that
 * calls it, so the first reply a person waits on does not pay for compiling them.
 */
export function warmUpMarkdownParser(): void {
  serializeMarkdownTree(WARM_UP_TEXT);
}

/** `source` parsed and read into the tree the screen draws, on the thread that calls it. */
export function parseMarkdownTree(source: string): Root {
  const { buffer, dollarStandIn } = serializeMarkdownTree(source);
  return materializeMarkdownTree(buffer, source, dollarStandIn);
}

/**
 * The bytes as a plain `ArrayBuffer` holding them alone, which a transfer can move to the page:
 * a view of shared memory, such as the parser's own, or of a pooled buffer, is copied out.
 */
export function standaloneBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
}

function serializedBytesOf(parsedText: string): Uint8Array {
  const handle = createMdastHandle(parsedText, MARKDOWN_FEATURES, true);
  try {
    return serializeHandle(handle);
  } finally {
    // The handle holds the parse's arena inside the parser's memory until it is dropped.
    dropHandle(handle);
  }
}

/**
 * Where each formula the tree in `bytes` holds that breaks Pandoc's rule opens in `parsedText`, in
 * order. Reads each node's type alone, so a text with no such formula costs one pass of reads.
 */
function refusedFormulaOpeners(bytes: Uint8Array, parsedText: string): number[] {
  const reader = new MdastReader(bytes);
  const openers: number[] = [];
  for (let nodeId = 0; nodeId < reader.nodeCount; nodeId += 1) {
    if (reader.getNodeType(nodeId) !== NodeType.InlineMath) {
      continue;
    }
    const position = reader.getPosition(nodeId);
    const start = position?.start.offset;
    const end = position?.end.offset;
    if (start !== undefined && end !== undefined && !isPandocFormula(parsedText, start, end)) {
      openers.push(start);
    }
  }
  return openers.sort((left, right) => left - right);
}

/** `text` with `standIn` in place of the character at each of `offsets`, ascending. */
function withStandIns(text: string, offsets: readonly number[], standIn: string): string {
  const parts: string[] = [];
  let copiedTo = 0;
  for (const offset of offsets) {
    parts.push(text.slice(copiedTo, offset), standIn);
    copiedTo = offset + 1;
  }
  parts.push(text.slice(copiedTo));
  return parts.join("");
}

/** The first stand-in `text` does not hold, or `undefined` when it holds them all. */
function standInFor(text: string): string | undefined {
  for (let code = FIRST_STAND_IN_CODE; code <= LAST_STAND_IN_CODE; code += 1) {
    const candidate = String.fromCharCode(code);
    if (DOLLAR_STAND_IN.test(candidate) && !text.includes(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
