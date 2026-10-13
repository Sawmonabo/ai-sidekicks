// The markdown trees every window shares. A settled block a body mounts is parsed on the page, at
// once, by the page's parser, and kept by the body only while it is mounted; that parser also cuts
// a body's text into blocks when the text is no longer than such a block. The app's one markdown
// worker cuts every longer text and parses the rest: a streaming tail, a block too long for the
// page, and every text while the page's parser could not start. A worker's tree is kept in a cache
// bounded in bytes and shared by every body that asks for the same text, and a tree a body holds
// stays kept while it is held, so a body mounted next draws it at once. The cache keys a tree by a
// hash of its text and keeps no copy of that text: a kept tree is the worker's binary tree, read
// into the mdast the screen draws when it is drawn, from the text its asker reads again (a long
// reply's block, cut from the packed body by range), and that mdast is kept only while something
// holds its nodes, such as a block on screen: a long reply keeps its blocks' buffers, not their
// nodes or text, and a block scrolled back into view reads its buffer again in the frame it mounts.
// A held block too long for the page has its buffer packed at idle moments, unpacked only when it
// is read, and is charged its packed bytes once packed. A document read once is parsed each time it
// is asked for. A block is parsed against the definitions its body declares, which the trees here
// are given as a preamble and returned without. A text whose last block is one long table is parsed
// in pieces and the table's rows read as they are held (`pieced-table.ts`), its pieces' trees kept
// in a cache of their own; a text that continues the last one parsed in pieces, as a streaming
// table grows, parses only the pieces it changed.

import type { Root, RootContent } from "mdast";

import { ByteBoundedCache } from "#renderer/lib/byte-bounded-cache.js";
import type { TextCompression } from "#renderer/lib/text/compression.js";
import { wideHashOf } from "#renderer/lib/text/hash.js";
import { describeFailure } from "#shared/failure-message.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import { markdownWorker, type MarkdownWorkerConnection } from "../worker/connection.js";
import type { MarkdownCutAnswer, MarkdownParseAnswer } from "../worker/messages.js";
import { treeWithoutPreamble } from "./definition-preamble.js";
import { materializeMarkdownTree } from "./materialized-tree.js";
import { PackedTreeBuffer } from "./packed-tree-buffer.js";
import type { PageParser } from "./page-parser.js";
import {
  parsePiecedTable,
  PIECE_TREE_BYTE_CAP,
  TablePieceTrees,
  type PiecedRows,
} from "./pieced-table.js";
import { TABLE_PIECE_CHARACTERS, tableCutOf } from "./table-cut.js";

/** What parsing one text came to: its tree, or why the parser could not give one. */
export type MarkdownParseOutcome =
  | {
      readonly status: "parsed";
      readonly root: Root;
      /**
       * What the tree keeps now, in bytes, read whole or not and packed or not; the cache charges
       * what it kept when stored, and a packed tree again once it is packed.
       */
      readonly treeByteCount: number;
    }
  | { readonly status: "failed"; readonly reason: string };

/** A text's tree, as a kept settled block holds it. */
export type ParsedMarkdown = Extract<MarkdownParseOutcome, { readonly status: "parsed" }>;

/** Hears what one asked-for tree came to. */
export type MarkdownTreeListener = (outcome: MarkdownParseOutcome) => void;

/**
 * Reads a settled block's text again, the same text each time: a kept tree is read into mdast
 * from it when it is drawn, so the cache keeps no copy of it.
 */
export type BlockSourceReader = () => string;

/**
 * The trees the app's windows draw: parsed on the page by the connection's page parser, or by the
 * one connection's worker.
 */
export class MarkdownTrees {
  /** The page's parser, which `parseSettledBlockNow` parses with once it is ready. */
  public readonly pageParser: PageParser;
  readonly #worker: MarkdownWorkerConnection;
  readonly #settledBlocks = new ByteBoundedCache<KeptTree>(
    MARKDOWN_BLOCK_CACHE_BYTE_CAP,
    (kept) => kept.treeByteCount,
  );
  /** The listeners of each settled block being parsed, by its cache key. */
  readonly #waitingBlocks = new Map<string, Set<KeptTreeListener>>();
  /**
   * The root of each kept tree read into mdast, by its nodes: a root lives as long as anything
   * holds its nodes, so a block on screen is answered the same nodes each time it is read.
   */
  readonly #rootsByNodes = new WeakMap<readonly RootContent[], Root>();
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
    this.pageParser = worker.pageParser;
    this.#pieceTrees = new TablePieceTrees((text, settle) => {
      worker.parse(text, settle);
    }, pieceTreeByteCap);
  }

  /**
   * A settled block's tree against `definitionPreamble`, parsed on the page now: `undefined` while
   * the page's parser is not ready, or for a block over `PAGE_PARSE_MAX_CHARACTERS`, which the
   * worker parses. Kept by nothing here; throws when the parser breaks on the text.
   */
  public parseSettledBlockNow(
    blockSource: string,
    definitionPreamble: string,
  ): ParsedMarkdown | undefined {
    if (this.pageParser.state !== "ready" || blockSource.length > PAGE_PARSE_MAX_CHARACTERS) {
      return undefined;
    }
    const root = this.pageParser.parse(definitionPreamble + blockSource);
    return {
      status: "parsed",
      root: treeWithoutPreamble(root, definitionPreamble.length),
      treeByteCount: 0,
    };
  }

  /** How many workers the connection has started; see `MarkdownWorkerConnection.startCount`. */
  public get workerStartCount(): number {
    return this.#worker.startCount;
  }

  /** Starts the worker if it is not running, so it loads the module the page's parser waits on. */
  public wakeWorker(): void {
    this.#worker.wake();
  }

  /**
   * A settled block's tree, if it was parsed against this preamble and is still kept, read when it
   * is drawn from the text `readSource` answers: `blockSource` itself unless the caller keeps the
   * tree and can read the text again.
   */
  public readSettledBlock(
    blockSource: string,
    definitionPreamble: string,
    readSource: BlockSourceReader = () => blockSource,
  ): ParsedMarkdown | undefined {
    const kept = this.#settledBlocks.get(settledBlockCacheKey(blockSource, definitionPreamble));
    return kept === undefined ? undefined : new KeptTreeView(kept, definitionPreamble, readSource);
  }

  /**
   * Whether two answers draw the same kept tree, each read from its own asker's text: a tree read
   * from the cache and the same tree held later change nothing drawn.
   */
  public isSameTree(first: ParsedMarkdown, second: ParsedMarkdown): boolean {
    return (
      first === second ||
      (first instanceof KeptTreeView && second instanceof KeptTreeView && first.isOf(second))
    );
  }

  /**
   * Ask for a settled block's tree against the definitions its body declares, read when it is
   * drawn from the text `readSource` answers, as `readSettledBlock` reads one. A kept tree is
   * handed over at once, the same tree each time; an ask for a block already being parsed joins it.
   */
  public requestSettledBlock(
    blockSource: string,
    definitionPreamble: string,
    listener: MarkdownTreeListener,
    readSource: BlockSourceReader = () => blockSource,
  ): Unsubscribe {
    const key = settledBlockCacheKey(blockSource, definitionPreamble);
    return this.#requestKept(key, blockSource, definitionPreamble, (outcome) => {
      listener(answerOf(outcome, definitionPreamble, readSource));
    });
  }

  /**
   * Ask for a settled block's tree as `requestSettledBlock` does, and hold it in the cache,
   * whatever its size, until the returned call lets it go; the body that draws the block next is
   * then answered at once. What bounds the held trees is their holders: a second call to let go
   * does nothing, so no holder frees another's hold. A landed hold keeps only its key. The worker's
   * tree of a block too long for the page is packed while it is kept.
   */
  public holdSettledBlock(
    blockSource: string,
    definitionPreamble: string,
    listener: MarkdownTreeListener,
    readSource: BlockSourceReader = () => blockSource,
  ): Unsubscribe {
    const key = settledBlockCacheKey(blockSource, definitionPreamble);
    const isOverPageCap = blockSource.length > PAGE_PARSE_MAX_CHARACTERS;
    const kept = this.#settledBlocks.get(key);
    if (kept !== undefined && this.#settledBlocks.hold(key)) {
      packOverPageCap(this.#settledBlocks, key, kept, isOverPageCap);
      listener(new KeptTreeView(kept, definitionPreamble, readSource));
      return letGoOf(this.#settledBlocks, { key, stopListening: NO_UNSUBSCRIBE });
    }
    const hold: SettledBlockHold = { key: undefined, stopListening: NO_UNSUBSCRIBE };
    let hasLanded = false;
    const stopListening = this.#requestKept(key, blockSource, definitionPreamble, (outcome) => {
      hasLanded = true;
      hold.stopListening = NO_UNSUBSCRIBE;
      if (outcome.status === "kept") {
        // Too large for the cache unheld, it is stored held.
        if (!this.#settledBlocks.hold(key)) {
          this.#settledBlocks.setHeld(key, outcome);
        }
        packOverPageCap(this.#settledBlocks, key, outcome, isOverPageCap);
        hold.key = key;
      }
      listener(answerOf(outcome, definitionPreamble, readSource));
    });
    // Dropped once landed: it holds the ask's listeners, which nothing calls again.
    if (!hasLanded) {
      hold.stopListening = stopListening;
    }
    return letGoOf(this.#settledBlocks, hold);
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
    const key = settledBlockCacheKey(source, definitionPreamble);
    this.#settledBlocks.setHeld(key, new WholeTree(parsed.root, parsed.treeByteCount));
    let isLetGo = false;
    return () => {
      if (!isLetGo) {
        isLetGo = true;
        this.#settledBlocks.release(key);
      }
    };
  }

  /**
   * Ask where the blocks of a body's text `source` end, its last ones too when `isFinal`. A text of
   * at most `PAGE_PARSE_MAX_CHARACTERS` is cut on the page while its parser is ready, answered
   * before this returns; any other is cut by the worker. Nothing is kept: a body keeps where its
   * blocks end itself.
   */
  public requestCut(
    source: string,
    isFinal: boolean,
    listener: (answer: MarkdownCutAnswer) => void,
  ): Unsubscribe {
    if (this.pageParser.state === "ready" && source.length <= PAGE_PARSE_MAX_CHARACTERS) {
      let answer: MarkdownCutAnswer;
      try {
        answer = { status: "cut", blockEnds: this.pageParser.cut(source, isFinal) };
      } catch (error: unknown) {
        answer = {
          status: "failed",
          reason: `The markdown parser failed: ${describeFailure(error)}`,
        };
      }
      listener(answer);
      return () => {};
    }
    let isListening = true;
    this.#worker.cut(source, isFinal, (answer) => {
      if (isListening) {
        listener(answer);
      }
    });
    return () => {
      isListening = false;
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
        listener(answerOf(outcome, definitionPreamble, () => source));
      }
    });
    return () => {
      isListening = false;
    };
  }

  /**
   * Hands `listener` the tree kept under `key`, or what parsing `blockSource` against
   * `definitionPreamble` comes to, which the cache keeps; an ask for a block already being parsed
   * joins it.
   */
  #requestKept(
    key: string,
    blockSource: string,
    definitionPreamble: string,
    listener: KeptTreeListener,
  ): Unsubscribe {
    const kept = this.#settledBlocks.get(key);
    if (kept !== undefined) {
      listener(kept);
      return NO_UNSUBSCRIBE;
    }
    const joined = this.#waitingBlocks.get(key);
    if (joined !== undefined) {
      joined.add(listener);
      return () => {
        joined.delete(listener);
      };
    }
    const listeners = new Set<KeptTreeListener>([listener]);
    this.#waitingBlocks.set(key, listeners);
    this.#parseAgainstDefinitions(blockSource, definitionPreamble, (outcome) => {
      this.#waitingBlocks.delete(key);
      if (outcome.status === "kept") {
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
   * Parse a text with the body's definitions in scope, its table read in pieces where its last
   * block is one long table, and keep only the text's own nodes.
   */
  #parseAgainstDefinitions(
    source: string,
    definitionPreamble: string,
    settle: KeptTreeListener,
  ): void {
    const cut = tableCutOf(source);
    if (cut === undefined) {
      this.#parseWhole(source, definitionPreamble, settle);
      return;
    }
    // A table read in pieces holds its text while its rows are read: a copy, so a cut of a longer
    // string keeps none of the rest alive.
    const ownSource = structuredClone(source);
    parsePiecedTable(
      this.#pieceTrees,
      ownSource,
      definitionPreamble,
      cut,
      this.#lastPieced,
      (outcome) => {
        if (outcome.status === "not-one-table") {
          this.#parseWhole(ownSource, definitionPreamble, settle);
          return;
        }
        if (outcome.status === "failed") {
          settle(outcome);
          return;
        }
        this.#lastPieced = outcome.rows;
        // Its pieces' trees are charged to their own cache, which bounds them.
        settle(new WholeTree(outcome.root, 0));
      },
    );
  }

  /**
   * Parse a text whole, its tree kept as the worker's buffer and read into mdast when drawn; the
   * text is sent to the worker and not kept.
   */
  #parseWhole(source: string, definitionPreamble: string, settle: KeptTreeListener): void {
    this.#worker.parse(definitionPreamble + source, (answer) => {
      settle(
        answer.status === "failed"
          ? answer
          : new BufferedTree(answer, this.#rootsByNodes, this.#worker.textCompression),
      );
    });
  }
}

/**
 * The longest settled block the page parses, in UTF-16 code units; a longer one is parsed by the
 * worker. A block a long table's cut reads in pieces is always longer, so the worker parses it.
 */
export const PAGE_PARSE_MAX_CHARACTERS: number = TABLE_PIECE_CHARACTERS;

/**
 * Bytes of parsed-block cache retained across every card, charged against each tree's buffer and
 * its key. Bounded in bytes, not entries, because block sizes span four orders of magnitude.
 */
const MARKDOWN_BLOCK_CACHE_BYTE_CAP = 2_097_152;

const NO_UNSUBSCRIBE: Unsubscribe = () => undefined;

/**
 * A settled block's cache key: the 64-bit hash of its preamble and its text, with both lengths,
 * so the cache holds no copy of either.
 */
function settledBlockCacheKey(blockSource: string, definitionPreamble: string): string {
  return wideHashOf([definitionPreamble, blockSource]);
}

/**
 * A tree the cache keeps, with no copy of the text it was parsed from: what it charges the cache,
 * and its root, read from the text its asker reads again where it must be.
 */
interface KeptTree {
  readonly status: "kept";
  readonly treeByteCount: number;
  rootOf(definitionPreamble: string, readSource: BlockSourceReader): Root;
}

/** Hears what one tree the cache keeps came to. */
type KeptTreeListener = (
  outcome: KeptTree | Extract<MarkdownParseOutcome, { readonly status: "failed" }>,
) => void;

/** What a kept tree's asker is answered: the tree read from its own text, or the failure. */
function answerOf(
  outcome: KeptTree | Extract<MarkdownParseOutcome, { readonly status: "failed" }>,
  definitionPreamble: string,
  readSource: BlockSourceReader,
): MarkdownParseOutcome {
  return outcome.status === "failed"
    ? outcome
    : new KeptTreeView(outcome, definitionPreamble, readSource);
}

/** A hold on a settled block's tree: its key once landed, and its ask in flight. */
interface SettledBlockHold {
  key: string | undefined;
  stopListening: Unsubscribe;
}

/**
 * Packs `kept`'s buffer while it is kept under `key`, when its block is too long for the page, and
 * charges `cache` its packed bytes once packed: the cache bounds what its trees hold, held or not.
 */
function packOverPageCap(
  cache: ByteBoundedCache<KeptTree>,
  key: string,
  kept: KeptTree,
  isOverPageCap: boolean,
): void {
  if (isOverPageCap && kept instanceof BufferedTree) {
    kept.queuePacking(() => {
      cache.recharge(key);
    });
  }
}

/** Lets go of `hold` once: stops its ask in flight and releases its tree from `cache`. */
function letGoOf(cache: ByteBoundedCache<KeptTree>, hold: SettledBlockHold): Unsubscribe {
  let isLetGo = false;
  return () => {
    if (isLetGo) {
      return;
    }
    isLetGo = true;
    hold.stopListening();
    if (hold.key !== undefined) {
      cache.release(hold.key);
    }
  };
}

/**
 * One text's tree kept as the worker's binary buffer, about a quarter of the mdast it reads into,
 * and read into that mdast when asked for, from the text its asker reads again. The mdast is held
 * weakly: it lives while anything holds its nodes or its root, and once nothing does it is read
 * from the buffer again on the next ask, within that call, unpacking the buffer if it is packed.
 */
class BufferedTree implements KeptTree {
  public readonly status = "kept";
  readonly #buffer: PackedTreeBuffer;
  readonly #dollarStandIn: string | undefined;
  readonly #rootsByNodes: WeakMap<readonly RootContent[], Root>;
  #root: WeakRef<Root> | undefined;

  /**
   * The tree in `answer`, its buffer packed through `compression` once asked; each root read is
   * kept in `rootsByNodes` while its nodes are held.
   */
  public constructor(
    answer: Extract<MarkdownParseAnswer, { readonly status: "parsed" }>,
    rootsByNodes: WeakMap<readonly RootContent[], Root>,
    compression: TextCompression,
  ) {
    this.#buffer = new PackedTreeBuffer(answer.buffer, compression);
    this.#dollarStandIn = answer.dollarStandIn;
    this.#rootsByNodes = rootsByNodes;
  }

  /** The buffer's bytes as held now, packed or not: all the tree keeps. */
  public get treeByteCount(): number {
    return this.#buffer.heldByteCount;
  }

  /**
   * Packs the buffer at the codec's idle moments, `hearPacked` hearing when it is packed; a second
   * ask does nothing.
   */
  public queuePacking(hearPacked: () => void): void {
    this.#buffer.queuePacking(hearPacked);
  }

  /**
   * The tree as the app draws it, read from `definitionPreamble` and the text `readSource`
   * answers, without the definitions the preamble restated: the same root while anything holds it
   * or its nodes. The synthetic definitions are dropped by source offset, not identity: a block's
   * real `[^1]: …` has the same identifier as the synthetic one and must survive. Every offset
   * counts the preamble, so a node's start offset minus the preamble's length is where it starts
   * in the text.
   */
  public rootOf(definitionPreamble: string, readSource: BlockSourceReader): Root {
    const held = this.#root?.deref();
    if (held !== undefined) {
      return held;
    }
    const root = treeWithoutPreamble(
      materializeMarkdownTree(
        this.#buffer.read(),
        definitionPreamble + readSource(),
        this.#dollarStandIn,
      ),
      definitionPreamble.length,
    );
    this.#rootsByNodes.set(root.children, root);
    this.#root = new WeakRef(root);
    return root;
  }
}

/**
 * A tree kept whole, as mdast: a long table read in pieces, which holds its own text while its
 * rows are read, or a tree its caller made.
 */
class WholeTree implements KeptTree {
  public readonly status = "kept";
  public readonly treeByteCount: number;
  readonly #root: Root;

  public constructor(root: Root, treeByteCount: number) {
    this.#root = root;
    this.treeByteCount = treeByteCount;
  }

  public rootOf(): Root {
    return this.#root;
  }
}

/** A kept tree as one asker holds it: read, when drawn, from the text that asker reads again. */
class KeptTreeView implements ParsedMarkdown {
  public readonly status = "parsed";
  readonly #kept: KeptTree;
  readonly #definitionPreamble: string;
  readonly #readSource: BlockSourceReader;

  public constructor(kept: KeptTree, definitionPreamble: string, readSource: BlockSourceReader) {
    this.#kept = kept;
    this.#definitionPreamble = definitionPreamble;
    this.#readSource = readSource;
  }

  public get root(): Root {
    return this.#kept.rootOf(this.#definitionPreamble, this.#readSource);
  }

  public get treeByteCount(): number {
    return this.#kept.treeByteCount;
  }

  /** Whether `other` holds the same kept tree. */
  public isOf(other: KeptTreeView): boolean {
    return this.#kept === other.#kept;
  }
}

/**
 * The app's markdown trees: one worker and one cache for every window. Made last, once the
 * constants its cache is sized by are set.
 */
export const appMarkdownTrees: MarkdownTrees = new MarkdownTrees(markdownWorker);
