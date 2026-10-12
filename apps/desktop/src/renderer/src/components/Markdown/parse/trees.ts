// The markdown trees every window shares, parsed by the app's one markdown worker: a settled
// block's tree, or the tree a streaming tail shows, is kept in a cache bounded in bytes and shared
// by every body that asks for the same text, and a tree a body holds stays kept while it is held,
// so a body mounted next draws it at once. A document read once is parsed each time it is asked
// for. A block is parsed against the definitions its whole body declares, which the trees here are
// given as a preamble and returned without. A text whose last block is one long table is parsed in
// pieces and the table's rows read as they are held (`pieced-table.ts`), its pieces' trees kept in a
// cache of their own; a text that continues the last one parsed in pieces, as a streaming table
// grows, parses only the pieces it changed.

import type { Root } from "mdast";
import { MdastReader } from "satteri/mdast-reader";

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { markdownWorker, type MarkdownWorkerConnection } from "../worker/connection.js";
import type { MarkdownParseAnswer } from "../worker/messages.js";
import { materializeMarkdownTree } from "./materialized-tree.js";
import {
  parsePiecedTable,
  PIECE_TREE_BYTE_CAP,
  TablePieceTrees,
  type PiecedRows,
} from "./pieced-table.js";
import { tableCutOf } from "./table-cut.js";

/** What parsing one text came to: its tree, or why the parser could not give one. */
export type MarkdownParseOutcome =
  | {
      readonly status: "parsed";
      readonly root: Root;
      /** What the tree holds once drawn whole, estimated in bytes: what the cache charges it. */
      readonly treeByteCount: number;
    }
  | { readonly status: "failed"; readonly reason: string };

/** A text's tree, as a kept settled block holds it. */
export type ParsedMarkdown = Extract<MarkdownParseOutcome, { readonly status: "parsed" }>;

/** Hears what one asked-for tree came to. */
export type MarkdownTreeListener = (outcome: MarkdownParseOutcome) => void;

/** The trees the app's windows draw, and the one connection that parses them. */
export class MarkdownTrees {
  readonly #worker: MarkdownWorkerConnection;
  readonly #settledBlocks = new ByteBoundedCache<ParsedMarkdown>(
    MARKDOWN_BLOCK_CACHE_BYTE_CAP,
    (parsed) => parsed.treeByteCount,
  );
  /** The listeners of each settled block being parsed, by its cache key. */
  readonly #waitingBlocks = new Map<string, Set<MarkdownTreeListener>>();
  readonly #pieceTrees: TablePieceTrees;
  /**
   * The rows of the last block parsed in pieces, whose pieces a text continuing it takes. It holds
   * that block's text, one text at most past what the cache holds.
   */
  #lastPieced: PiecedRows | undefined;

  /** `pieceTreeByteCap` bounds the bytes of the long tables' piece trees kept at once. */
  public constructor(
    worker: MarkdownWorkerConnection,
    pieceTreeByteCap: number = PIECE_TREE_BYTE_CAP,
  ) {
    this.#worker = worker;
    this.#pieceTrees = new TablePieceTrees((text, settle) => {
      worker.parse(text, settle);
    }, pieceTreeByteCap);
  }

  /** A settled block's tree, if it was parsed against this preamble and is still kept. */
  public readSettledBlock(
    blockSource: string,
    definitionPreamble: string,
  ): ParsedMarkdown | undefined {
    return this.#settledBlocks.get(settledBlockCacheKey(blockSource, definitionPreamble));
  }

  /**
   * Ask for a settled block's tree against the definitions its body declares. A kept tree is
   * handed over at once, the same object each time; an ask for a block already being parsed joins
   * it. The answer is kept, never the caller's string, which may be a cut of a much longer one.
   */
  public requestSettledBlock(
    blockSource: string,
    definitionPreamble: string,
    listener: MarkdownTreeListener,
  ): Unsubscribe {
    const kept = this.readSettledBlock(blockSource, definitionPreamble);
    if (kept !== undefined) {
      listener(kept);
      return NO_UNSUBSCRIBE;
    }
    // The key outlives the call and the tree's text values are cuts of what was parsed: both
    // would keep a cut's whole parent string alive, so both come from a copy of the text.
    const ownSource = structuredClone(blockSource);
    const key = settledBlockCacheKey(ownSource, definitionPreamble);
    const joined = this.#waitingBlocks.get(key);
    if (joined !== undefined) {
      joined.add(listener);
      return () => {
        joined.delete(listener);
      };
    }
    const listeners = new Set<MarkdownTreeListener>([listener]);
    this.#waitingBlocks.set(key, listeners);
    this.#parseAgainstDefinitions(ownSource, definitionPreamble, (outcome) => {
      this.#waitingBlocks.delete(key);
      if (outcome.status === "parsed") {
        this.#settledBlocks.set(key, outcome);
      }
      for (const waitingListener of [...listeners]) {
        waitingListener(outcome);
      }
    });
    return () => {
      listeners.delete(listener);
    };
  }

  /**
   * Ask for a settled block's tree as `requestSettledBlock` does, and hold it in the cache,
   * whatever its size, until the returned call lets it go; the body that draws the block next is
   * then answered at once. What bounds the held trees is their holders: a second call to let go
   * does nothing, so no holder frees another's hold.
   */
  public holdSettledBlock(
    blockSource: string,
    definitionPreamble: string,
    listener: MarkdownTreeListener,
  ): Unsubscribe {
    let heldKey: string | undefined;
    const hitKey = settledBlockCacheKey(blockSource, definitionPreamble);
    let stopListening = NO_UNSUBSCRIBE;
    const kept = this.#settledBlocks.get(hitKey);
    if (kept !== undefined && this.#settledBlocks.hold(hitKey)) {
      heldKey = hitKey;
      listener(kept);
    } else {
      stopListening = this.requestSettledBlock(blockSource, definitionPreamble, (outcome) => {
        if (outcome.status === "parsed") {
          // Stored under a key built from a copy, so it keeps no cut's parent string alive.
          heldKey = settledBlockCacheKey(structuredClone(blockSource), definitionPreamble);
          this.#settledBlocks.setHeld(heldKey, outcome);
        }
        listener(outcome);
      });
    }
    let isLetGo = false;
    return () => {
      if (isLetGo) {
        return;
      }
      isLetGo = true;
      stopListening();
      if (heldKey !== undefined) {
        this.#settledBlocks.release(heldKey);
      }
    };
  }

  /**
   * Keep a tree its caller made for `source` against `definitionPreamble`, such as a streaming
   * tail's tree grown by its last append, and hold it as `holdSettledBlock` does, so another body
   * showing the same text is answered at once. Answers the call that lets it go.
   */
  public holdLandedTree(
    source: string,
    definitionPreamble: string,
    parsed: ParsedMarkdown,
  ): Unsubscribe {
    const key = settledBlockCacheKey(structuredClone(source), definitionPreamble);
    this.#settledBlocks.setHeld(key, parsed);
    let isLetGo = false;
    return () => {
      if (!isLetGo) {
        isLetGo = true;
        this.#settledBlocks.release(key);
      }
    };
  }

  /** Ask for the tree of a text parsed once, such as a reply being copied. */
  public requestTree(
    source: string,
    definitionPreamble: string,
    listener: MarkdownTreeListener,
  ): Unsubscribe {
    let isListening = true;
    this.#parseAgainstDefinitions(source, definitionPreamble, (outcome) => {
      if (isListening) {
        listener(outcome);
      }
    });
    return () => {
      isListening = false;
    };
  }

  /**
   * Parse a text with the body's definitions in scope, its table read in pieces where its last
   * block is one long table, and keep only the text's own nodes.
   */
  #parseAgainstDefinitions(
    source: string,
    definitionPreamble: string,
    settle: (outcome: MarkdownParseOutcome) => void,
  ): void {
    const cut = tableCutOf(source);
    if (cut === undefined) {
      this.#parseWhole(source, definitionPreamble, settle);
      return;
    }
    parsePiecedTable(
      this.#pieceTrees,
      source,
      definitionPreamble,
      cut,
      this.#lastPieced,
      (outcome) => {
        if (outcome.status === "not-one-table") {
          this.#parseWhole(source, definitionPreamble, settle);
          return;
        }
        if (outcome.status === "failed") {
          settle(outcome);
          return;
        }
        this.#lastPieced = outcome.rows;
        // Its pieces' trees are charged to their own cache, which bounds them.
        settle({ status: "parsed", root: outcome.root, treeByteCount: 0 });
      },
    );
  }

  /**
   * Parse a text whole and read its tree as the app draws it. The synthetic definitions are dropped
   * by source offset, not identity: a block's real `[^1]: …` has the same identifier as the
   * synthetic one and must survive. Every offset in the result counts the preamble, so a node's
   * start offset minus the preamble's length is where it starts in the text.
   */
  #parseWhole(
    source: string,
    definitionPreamble: string,
    settle: (outcome: MarkdownParseOutcome) => void,
  ): void {
    const parsedText = definitionPreamble + source;
    this.#worker.parse(parsedText, (answer) => {
      settle(
        answer.status === "failed" ? answer : wholeTreeOf(answer, parsedText, definitionPreamble),
      );
    });
  }
}

/**
 * The definitions a block is parsed against, as a minimal document preamble.
 *
 * GFM resolves `[^1]` only against definitions in its own document, and a lone reference
 * becomes literal text no later pass can upgrade. Every identifier the whole body declares is
 * therefore restated, body-less, ahead of each block. Sorted so the same set yields the same
 * bytes and cache key; a body with no footnotes gets `""`, leaving its key unchanged.
 */
export function footnoteDefinitionPreamble(definedIdentifiers: ReadonlySet<string>): string {
  if (definedIdentifiers.size === 0) {
    return "";
  }
  const definitionLines = [...definedIdentifiers]
    .sort()
    .map((identifier) => `[^${identifier}]:\n`)
    .join("");
  return definitionLines + FOOTNOTE_PREAMBLE_TERMINATOR;
}

/**
 * Bytes of parsed-block cache retained across every card, charged against the source text and
 * an estimate of the tree it parsed to. Bounded in bytes, not entries, because block sizes span
 * four orders of magnitude.
 */
const MARKDOWN_BLOCK_CACHE_BYTE_CAP = 2_097_152;

/**
 * What one parsed node holds on the heap once read, in bytes. Measured: a table of 24,700 rows read
 * whole held 100 MB in 395,000 nodes, about 253 bytes a node, mostly the position objects, and one
 * of 3,077 rows 13 MB in 49,000. Charging the source alone would let a full cache hold many times
 * its cap.
 */
const MDAST_NODE_BYTE_ESTIMATE = 260;

/**
 * What separates the synthetic definitions from the block's own text.
 *
 * A blank line is not enough: a footnote definition takes indented lines after a blank one as
 * its continuation, so it would swallow a block that opens on indented code. An HTML comment
 * at column zero ends the definition and is dropped with the preamble.
 */
const FOOTNOTE_PREAMBLE_TERMINATOR = "\n<!---->\n\n";

/**
 * What joins the two halves of a settled block's cache key. A preamble holds no NUL, since the
 * parser reads a NUL in a label as U+FFFD, so the first NUL in a key always ends its preamble.
 */
const SETTLED_KEY_SEPARATOR = "\u0000";

const NO_UNSUBSCRIBE: Unsubscribe = () => undefined;

function settledBlockCacheKey(blockSource: string, definitionPreamble: string): string {
  return definitionPreamble === ""
    ? blockSource
    : definitionPreamble + SETTLED_KEY_SEPARATOR + blockSource;
}

/** The tree in `answer`, parsed from `parsedText`, without the definitions its preamble restated. */
function wholeTreeOf(
  answer: Extract<MarkdownParseAnswer, { readonly status: "parsed" }>,
  parsedText: string,
  definitionPreamble: string,
): ParsedMarkdown {
  const nodeCount = new MdastReader(answer.buffer).nodeCount;
  const root = materializeMarkdownTree(answer.buffer, parsedText, answer.dollarStandIn);
  return {
    status: "parsed",
    root:
      definitionPreamble === ""
        ? root
        : {
            ...root,
            children: root.children.filter(
              (child) => (child.position?.start.offset ?? 0) >= definitionPreamble.length,
            ),
          },
    // The tree reads its nodes from the buffer as they are drawn, so it holds both.
    treeByteCount: answer.buffer.byteLength + nodeCount * MDAST_NODE_BYTE_ESTIMATE,
  };
}

/**
 * The app's markdown trees: one worker and one cache for every window. Made last, once the
 * constants its cache is sized by are set.
 */
export const appMarkdownTrees: MarkdownTrees = new MarkdownTrees(markdownWorker);
