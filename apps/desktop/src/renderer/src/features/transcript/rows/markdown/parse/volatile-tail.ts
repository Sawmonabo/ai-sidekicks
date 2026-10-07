// The unfinished end of a streaming body, parsed on every frame the reveal releases text. Most
// frames append a few words to the last line of prose, or a few lines to an open code fence; such
// an append extends the last parse instead of parsing the tail again. Any other change, or an
// append that could change what an earlier character means, parses the whole tail. Correctness
// comes first: the extension is taken only where the append provably lands in one node.

import type { Nodes, Parents, RootContent } from "mdast";

import {
  mendVolatileTail,
  parseAgainstDefinitions,
  type MarkdownRoot,
} from "#renderer/components/Markdown/parse.js";

/**
 * The containers an extended text node may sit in: none of them reads the text it holds, so a
 * longer last text node leaves each of them as it was.
 */
const PROSE_CONTAINER_TYPES: ReadonlySet<Nodes["type"]> = new Set<Nodes["type"]>([
  "root",
  "paragraph",
  "heading",
  "emphasis",
  "strong",
  "delete",
  "blockquote",
  "list",
  "listItem",
  "table",
  "tableRow",
  "tableCell",
]);

/**
 * An append that is only words, spaces and the punctuation that opens and closes nothing in
 * commonmark or GFM: no delimiter, bracket, escape, entity, tag, pipe, hash, tab or line break.
 */
const PLAIN_APPEND = /^[\p{L}\p{M}\p{N}\p{Pd}\p{Pi}\p{Pf} ,.;:?"'%+=/{}^()…]+$/u;

/** One character of `PLAIN_APPEND`'s set other than a space: what the text may end on. */
const PLAIN_CHARACTER = /^[\p{L}\p{M}\p{N}\p{Pd}\p{Pi}\p{Pf},.;:?"'%+=/{}^()…]$/u;

/**
 * A line whose block structure is decided: a word followed by a space. Every block marker (a
 * list bullet or number, a heading's hashes, a quote's `>`) ends before its line's first word
 * and its following space, so nothing appended after them can turn the line into another block.
 */
const DECIDED_LINE = /[\p{L}\p{N}][^\n]*[ \t]/u;

/**
 * Text that an appended character could turn into a link or decode: a GFM autolink's `www.`,
 * scheme or `@`, a character reference's `&`, an escape's backslash, or an autolink's `<`.
 */
const LINKABLE_OR_ENCODED = /www\.|:\/\/|mailto:|xmpp:|[@&\\<]/iu;

/** A line that opens or closes a code fence, or might once the rest of it arrives. */
const FENCE_LINE = /^ {0,3}(?:`{3,}|~{3,})/u;

/**
 * Parses one body's volatile tail frame after frame, extending the last parse where the new
 * tail only appends to the node the last one ended in. The result is always what a whole parse
 * of the mended tail against the same definitions would give, positions included.
 */
export class VolatileTailParser {
  #lastParse: TailParse | undefined;

  /** The tail's tree, against the definitions the rest of the body declares. */
  public parse(tailSource: string, definitionPreamble: string): MarkdownRoot {
    const mended = mendVolatileTail(tailSource);
    const lastParse = this.#lastParse;
    if (lastParse?.definitionPreamble === definitionPreamble) {
      if (mended === lastParse.mended) {
        return lastParse.root;
      }
      const extended = extendParse(lastParse, mended);
      if (extended !== undefined) {
        this.#lastParse = extended;
        return extended.root;
      }
    }
    const parsed: TailParse = {
      definitionPreamble,
      mended,
      closers: mended.slice(commonPrefixLength(mended, tailSource)),
      root: parseAgainstDefinitions(mended, definitionPreamble),
    };
    this.#lastParse = parsed;
    return parsed.root;
  }
}

/** One parse the next frame's append can extend. */
interface TailParse {
  readonly definitionPreamble: string;
  /** The mended tail the root was parsed from. */
  readonly mended: string;
  /**
   * The end of `mended` that `remend` wrote rather than took from the tail: the closers of the
   * tail's open constructs. An extension keeps them and grows the text before them.
   */
  readonly closers: string;
  readonly root: MarkdownRoot;
}

/**
 * The last parse grown to `mended`, or `undefined` to parse whole. `remend` decides what to close
 * from the whole tail, so the extension is taken only when it wrote the same closers after text
 * that only grew; the guards then prove the growth lands in the node the last parse ended in.
 */
function extendParse(lastParse: TailParse, mended: string): TailParse | undefined {
  const closers = lastParse.closers;
  const lastText = lastParse.mended.slice(0, lastParse.mended.length - closers.length);
  if (
    mended.length <= lastParse.mended.length ||
    !mended.startsWith(lastText) ||
    !mended.endsWith(closers)
  ) {
    return undefined;
  }
  const growth: TextGrowth = {
    lastParse,
    lastText,
    appended: mended.slice(lastText.length, mended.length - closers.length),
  };
  const root = extendOpenFence(growth) ?? extendTrailingText(growth);
  return root === undefined ? undefined : { ...lastParse, mended, root };
}

/** Text a frame appended to the last parse's text, before the closers both keep. */
interface TextGrowth {
  readonly lastParse: TailParse;
  /** The last mended tail without its closers: the text the last parse's nodes cover. */
  readonly lastText: string;
  readonly appended: string;
}

/**
 * The tree with the growth added to an unclosed code fence the tail ends in. Inside an open fence
 * every character is literal until a closing fence line, so only a line that could close it
 * needs the whole parse. Taken only for a fence at the top level and column one whose content is
 * the text after its opening line verbatim, less the line ending the parse holds back: a closed
 * fence, indented code, or a fence holding closers `remend` wrote holds something else.
 */
function extendOpenFence({ lastParse, lastText, appended }: TextGrowth): MarkdownRoot | undefined {
  const root = lastParse.root;
  const code = root.children.at(-1);
  if (code?.type !== "code" || appended.includes("\r")) {
    return undefined;
  }
  const preambleLength = lastParse.definitionPreamble.length;
  const start = code.position?.start;
  const end = code.position?.end;
  if (start === undefined || end === undefined || start.column !== 1) {
    return undefined;
  }
  // With no line ending after the opener yet, the slice is the whole text, which no value matches.
  const contentStart = lastText.indexOf("\n", (start.offset ?? 0) - preambleLength) + 1;
  if (code.value !== openFenceValueOf(lastText.slice(contentStart))) {
    return undefined;
  }
  const openLines = (lastText.slice(lastText.lastIndexOf("\n") + 1) + appended).split("\n");
  if (openLines.some((line) => FENCE_LINE.test(line))) {
    return undefined;
  }
  const grownCode = {
    ...code,
    value: openFenceValueOf(lastText.slice(contentStart) + appended),
    position: { start, end: advanced(end, appended) },
  };
  return {
    ...root,
    children: [...root.children.slice(0, -1), grownCode],
    position: withEndAdvanced(root.position, appended),
  };
}

/**
 * The tree with the growth added to the text node the tail ends in, inside prose containers
 * only. Each guard names a way an append can reach back: trailing whitespace a paragraph and its
 * text count differently, a delimiter or bracket the last character could pair with, a line whose
 * block marker is still open, a paragraph that may be a link definition, and a word that may
 * become a link.
 */
function extendTrailingText({
  lastParse,
  lastText,
  appended,
}: TextGrowth): MarkdownRoot | undefined {
  if (!PLAIN_APPEND.test(appended) || appended.endsWith(" ")) {
    return undefined;
  }
  const { containers, leaf: text } = trailingPathOf(lastParse.root);
  if (text.type !== "text" || !containers.every((node) => PROSE_CONTAINER_TYPES.has(node.type))) {
    return undefined;
  }
  const preambleLength = lastParse.definitionPreamble.length;
  const paragraph = containers.findLast((node) => node.type === "paragraph");
  const paragraphStart = (paragraph?.position?.start.offset ?? preambleLength) - preambleLength;
  if (
    text.position?.end.offset !== preambleLength + lastText.length ||
    !PLAIN_CHARACTER.test(lastText.charAt(lastText.length - 1)) ||
    !DECIDED_LINE.test(lastText.slice(lastText.lastIndexOf("\n") + 1)) ||
    (paragraph !== undefined && lastText.charAt(paragraphStart) === "[") ||
    LINKABLE_OR_ENCODED.test(lastWordOf(lastText) + appended)
  ) {
    return undefined;
  }
  // Every node on the path ends at the text's end or after it on a closer, so each moves by the
  // append.
  let grownNode: Nodes = {
    ...text,
    value: text.value + appended,
    position: withEndAdvanced(text.position, appended),
  };
  for (const container of containers.toReversed()) {
    grownNode = {
      ...container,
      children: [...container.children.slice(0, -1), grownNode],
      position: withEndAdvanced(container.position, appended),
    } as Parents;
  }
  // The path starts at the root, so the last container grown is the root.
  return grownNode as MarkdownRoot;
}

/** The path from the root down to its last leaf: the leaf an append lands in, and its holders. */
interface TrailingPath {
  /** The root first, then each holder of the leaf, outermost first. */
  readonly containers: readonly Parents[];
  readonly leaf: Nodes;
}

function trailingPathOf(root: MarkdownRoot): TrailingPath {
  const containers: Parents[] = [];
  let node: Nodes = root;
  while ("children" in node) {
    const lastChild: RootContent | undefined = node.children.at(-1);
    if (lastChild === undefined) {
      break;
    }
    containers.push(node);
    node = lastChild;
  }
  return { containers, leaf: node };
}

/** An open fence's code value: its content, less the line ending that last content line holds. */
function openFenceValueOf(content: string): string {
  return content.endsWith("\n") ? content.slice(0, -1) : content;
}

/** How many leading characters two strings share. */
function commonPrefixLength(first: string, second: string): number {
  const limit = Math.min(first.length, second.length);
  let length = 0;
  while (length < limit && first.charCodeAt(length) === second.charCodeAt(length)) {
    length += 1;
  }
  return length;
}

/** The run of non-space characters ending `text`: the word an append continues. */
function lastWordOf(text: string): string {
  let start = text.length;
  while (start > 0 && !/\s/u.test(text.charAt(start - 1))) {
    start -= 1;
  }
  return text.slice(start);
}

/** Where a node sits in the parsed text, as the parser types it. */
type Position = NonNullable<Nodes["position"]>;

/** One end of a `Position`. */
type Point = Position["start"];

/** A position whose end moved past `appended`; a node without a position keeps none. */
function withEndAdvanced(position: Position | undefined, appended: string): Position | undefined {
  return position === undefined
    ? undefined
    : { start: position.start, end: advanced(position.end, appended) };
}

/** Where a point lands after `appended` follows it. */
function advanced(point: Point, appended: string): Point {
  const offset = (point.offset ?? 0) + appended.length;
  const lastNewline = appended.lastIndexOf("\n");
  if (lastNewline === -1) {
    return { line: point.line, column: point.column + appended.length, offset };
  }
  const newlineCount = appended.split("\n").length - 1;
  return { line: point.line + newlineCount, column: appended.length - lastNewline, offset };
}
