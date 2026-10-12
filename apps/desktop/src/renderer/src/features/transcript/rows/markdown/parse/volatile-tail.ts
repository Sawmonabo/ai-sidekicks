// The unfinished end of a streaming body, parsed again on every frame the reveal releases text. Most
// frames append a few words to the last line of prose, or a few lines to an open code fence; such
// an append extends the tree on screen at once instead of parsing the tail again. Any other change,
// or an append that could change what an earlier character means, asks the parse worker for the
// whole tail, and the tree on screen stays until that tree lands; nothing unparsed is ever drawn.
// The tree on screen is held in the app's shared trees under its text, so another parser of the
// same tail, as a body mounted again starts one, shows it at once. Correctness comes first: the
// extension is taken only where the append provably lands in one node.

import type { Nodes, Parents, Root, RootContent } from "mdast";
import remend from "remend";

import { isReadInPieces } from "#renderer/components/Markdown/parse/pieced-table.js";
import type {
  MarkdownParseOutcome,
  MarkdownTrees,
  ParsedMarkdown,
} from "#renderer/components/Markdown/parse/trees.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { hasPrefix } from "#renderer/lib/text-prefix.js";
import type { Unsubscribe } from "#shared/preload-api.js";

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
 * The options `remend` is given for the volatile tail.
 *
 * `inlineKatex` stays off because a lone `$` is ambiguous with a currency symbol. `linkMode`
 * stays `"protocol"` so an unfinished link becomes the sentinel URL the mapper renders as
 * plain text; `"text-only"` would drop the link text mid-stream and bring it back later.
 */
const REMEND_OPTIONS = { inlineKatex: false, linkMode: "protocol" } as const;

/**
 * What the tail shows: its tree and the tail that tree answers, as `update` was given it, or why
 * the parser could not give one.
 */
export type VolatileTailView =
  | {
      readonly status: "parsed";
      readonly root: Root;
      readonly tailSource: string;
      /** The definitions the tree was parsed after, whose length every offset in it counts. */
      readonly definitionPreamble: string;
    }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Parses one body's volatile tail frame after frame. A frame that only appends to the node the
 * tree on screen ends in extends that tree at once; any other frame asks for a whole parse, one at
 * a time, and keeps the tree on screen until it lands. Every tree shown is what a whole parse of
 * the mended tail against the same definitions gives, positions included.
 */
export class VolatileTailParser {
  readonly #trees: MarkdownTrees;
  readonly #changes = new Emitter<void>("volatile tail tree");
  /** The tree on screen and what it was parsed from, or `undefined` before the first lands. */
  #shown: TailParse | undefined;
  #view: VolatileTailView | undefined;
  /** The newest tail asked for that neither the tree on screen nor the parse in flight answers. */
  #wanted: WantedTail | undefined;
  /** Stops listening for the whole parse in flight, while one is. */
  #inFlight: Unsubscribe | undefined;
  /** Lets go of the tree on screen, held in the shared trees while it is shown. */
  #shownHold: Unsubscribe = NO_HOLD;
  #askCount = 0;

  /** What the tail shows now, or `undefined` before its first tree lands. */
  public readonly read = (): VolatileTailView | undefined => this.#view;

  /** Hear each change to what the tail shows. */
  public readonly subscribe = (listener: () => void): Unsubscribe =>
    this.#changes.subscribe(listener);

  public constructor(trees: MarkdownTrees) {
    this.#trees = trees;
  }

  /** Show the tail as `tailSource` against the definitions the rest of the body declares. */
  public update(tailSource: string, definitionPreamble: string): void {
    const tail = this.#ask(tailSource, definitionPreamble);
    const mended = tail.mended;
    const shown = this.#shown;
    if (shown?.definitionPreamble === definitionPreamble && shown.mended === mended) {
      this.#wanted = undefined;
      // The tree on screen answers this ask, so an older ask still in flight never replaces it.
      const answered = { ...shown, askNumber: tail.askNumber, tailSource };
      // A tail shown again after `close` holds its tree in the shared trees once more.
      const hold =
        this.#shownHold === NO_HOLD
          ? this.#trees.holdLandedTree(mended, definitionPreamble, parsedOf(shown))
          : this.#shownHold;
      if (shown.tailSource === tailSource) {
        this.#shown = answered;
        this.#shownHold = hold;
      } else {
        this.#show(answered, hold);
      }
      return;
    }
    // Another parser of this tail may already show its tree, or have grown it.
    if (this.#trees.readSettledBlock(mended, definitionPreamble) !== undefined) {
      this.#wanted = undefined;
      this.#holdWhole(tail);
      return;
    }
    if (this.#extendShown(tail)) {
      this.#wanted = undefined;
      return;
    }
    this.#wanted = tail;
    if (this.#inFlight === undefined) {
      this.#send();
    }
  }

  /**
   * Show the tree the shared trees keep of `tailSource` against `definitionPreamble`, while no
   * tree is shown yet, without asking for a parse or emitting a change, so a body reading its
   * tail draws it on its first frame. The next `update` of the same tail holds it.
   */
  public showKept(tailSource: string, definitionPreamble: string): void {
    if (this.#view !== undefined) {
      return;
    }
    const tail = this.#ask(tailSource, definitionPreamble);
    const kept = this.#trees.readSettledBlock(tail.mended, definitionPreamble);
    if (kept !== undefined) {
      this.#shown = { ...tail, root: kept.root, treeByteCount: kept.treeByteCount };
      this.#view = { status: "parsed", root: kept.root, tailSource, definitionPreamble };
    }
  }

  /**
   * Stop listening for the parse in flight, and let go of the tree on screen, as the tail leaves
   * the screen; the tree stays shown here.
   */
  public close(): void {
    this.#inFlight?.();
    this.#inFlight = undefined;
    this.#shownHold();
    this.#shownHold = NO_HOLD;
  }

  /** The next ask for `tailSource`, mended, against `definitionPreamble`. */
  #ask(tailSource: string, definitionPreamble: string): WantedTail {
    const mended = mendVolatileTail(tailSource);
    this.#askCount += 1;
    return {
      askNumber: this.#askCount,
      tailSource,
      definitionPreamble,
      mended,
      closers: mended.slice(
        hasPrefix(mended, tailSource) ? tailSource.length : commonPrefixLength(mended, tailSource),
      ),
    };
  }

  /** Show the tree on screen grown to `tail`, if the growth provably lands in one node. */
  #extendShown(tail: WantedTail): boolean {
    const shown = this.#shown;
    if (shown?.definitionPreamble !== tail.definitionPreamble) {
      return false;
    }
    const extended = extendParse(shown, tail.mended);
    if (extended === undefined) {
      return false;
    }
    this.#show(
      { ...extended, askNumber: tail.askNumber, tailSource: tail.tailSource },
      this.#trees.holdLandedTree(tail.mended, tail.definitionPreamble, parsedOf(extended)),
    );
    return true;
  }

  /** Shows the kept tree of `tail`, answered while it is asked for. */
  #holdWhole(tail: WantedTail): void {
    let kept: MarkdownParseOutcome | undefined;
    const letGo = this.#trees.holdSettledBlock(tail.mended, tail.definitionPreamble, (outcome) => {
      kept = outcome;
    });
    if (kept?.status === "parsed") {
      this.#show({ ...tail, root: kept.root, treeByteCount: kept.treeByteCount }, letGo);
    } else {
      letGo();
    }
  }

  #send(): void {
    const tail = this.#wanted;
    if (tail === undefined) {
      return;
    }
    this.#wanted = undefined;
    let answeredAtOnce: MarkdownParseOutcome | undefined;
    let isAsking = true;
    const letGo = this.#trees.holdSettledBlock(tail.mended, tail.definitionPreamble, (outcome) => {
      if (isAsking) {
        answeredAtOnce = outcome;
        return;
      }
      this.#land(tail, outcome, letGo);
    });
    isAsking = false;
    // A stand-in parser answers before the request returns, and nothing is in flight then.
    if (answeredAtOnce === undefined) {
      this.#inFlight = letGo;
    } else {
      this.#land(tail, answeredAtOnce, letGo);
    }
  }

  #land(tail: WantedTail, outcome: MarkdownParseOutcome, letGo: Unsubscribe): void {
    this.#inFlight = undefined;
    if (outcome.status === "failed") {
      this.#view = outcome;
      this.#changes.emit();
      return;
    }
    // A tree for an older tail than the one on screen, which an extension already passed, is
    // dropped; it never replaces newer text.
    if (tail.askNumber > (this.#shown?.askNumber ?? 0)) {
      this.#show({ ...tail, root: outcome.root, treeByteCount: outcome.treeByteCount }, letGo);
    } else {
      letGo();
    }
    const wanted = this.#wanted;
    if (wanted !== undefined && this.#extendShown(wanted)) {
      this.#wanted = undefined;
    }
    this.#send();
  }

  /** Shows `parse`, its tree held in the shared trees by `hold` in place of the last one shown. */
  #show(parse: TailParse, hold: Unsubscribe): void {
    if (hold !== this.#shownHold) {
      this.#shownHold();
      this.#shownHold = hold;
    }
    this.#shown = parse;
    this.#view = {
      status: "parsed",
      root: parse.root,
      tailSource: parse.tailSource,
      definitionPreamble: parse.definitionPreamble,
    };
    this.#changes.emit();
  }
}

/** Lets go of nothing: no tree is shown yet. */
const NO_HOLD: Unsubscribe = () => undefined;

/** The volatile tail with its unterminated constructs closed, ready to parse. */
export function mendVolatileTail(tailSource: string): string {
  // `remend` runs on the tail only: on a settled block it would rewrite finished text, and on the
  // whole message it would rewrite the committed prefix every frame.
  return remend(tailSource, REMEND_OPTIONS);
}

/** A tail asked for: its order among the asks, and what it parses to with its closers. */
interface WantedTail {
  readonly askNumber: number;
  /** The tail as `update` was given it, before mending. */
  readonly tailSource: string;
  readonly definitionPreamble: string;
  /** The mended tail. */
  readonly mended: string;
  /**
   * The end of `mended` that `remend` wrote rather than took from the tail: the closers of the
   * tail's open constructs. An extension keeps them and grows the text before them.
   */
  readonly closers: string;
}

/** A tree on screen, which the next frame's append can extend. */
interface TailParse extends WantedTail {
  readonly root: Root;
  /** What the tree's parse charged the shared trees; a grown tree holds as much. */
  readonly treeByteCount: number;
}

/** A tree on screen as the shared trees keep it. */
function parsedOf(parse: TailParse): ParsedMarkdown {
  return { status: "parsed", root: parse.root, treeByteCount: parse.treeByteCount };
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
    !hasPrefix(mended, lastText) ||
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
function extendOpenFence({ lastParse, lastText, appended }: TextGrowth): Root | undefined {
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
function extendTrailingText({ lastParse, lastText, appended }: TextGrowth): Root | undefined {
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
  return grownNode as Root;
}

/**
 * The path from the root down to its last leaf: the leaf an append lands in, and its holders. A
 * table read in pieces ends the path: its rows are read only while they are held.
 */
interface TrailingPath {
  /** The root first, then each holder of the leaf, outermost first. */
  readonly containers: readonly Parents[];
  readonly leaf: Nodes;
}

function trailingPathOf(root: Root): TrailingPath {
  const containers: Parents[] = [];
  let node: Nodes = root;
  while ("children" in node && !isReadInPieces(node)) {
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
