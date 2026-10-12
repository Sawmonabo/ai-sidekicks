// One markdown body's blocks, as its renderer keys, windows, resolves and draws them. Each settled
// block is read once, when it settles: a key from its place and a fingerprint of its text, and, for
// a block that could define a footnote, the footnote identifiers it defines, kept as strings once
// its parse lands. A block keeps where its text sits in the body's text, never a copy of it, so a
// long reply is held once; its text is cut again when it is parsed. Each settled block's tree is
// held here while the body is, so a block drawn again, scrolled back into a long body's window,
// draws on the frame it mounts; it is held in the app's shared trees too, with each tree read for
// the footnotes a block defines and the tail's, so another body of the same text, as a row mounted
// again draws, reads every one at once. The volatile tail is parsed here as it grows, and alone too
// while it could define a footnote.
//
// What is drawn moves in one step. A body's first draw waits until the body's definitions are
// read and every settled block's tree and its tail's have landed against them. After that, a block
// that settles stays inside the drawn tail, which keeps growing, while its own tree and the shorter
// tail's tree are parsed behind it; the body draws the block on its own only once both have landed
// and the shorter tail covers every character the drawn one did. A body that finishes moves its
// last blocks the same way. So no frame draws a block without its tree, draws a block's text twice,
// or draws fewer characters than the frame before.

import type { FootnoteDefinition, Root, RootContent } from "mdast";

import { collectFootnoteDefinitions } from "#renderer/components/Markdown/footnotes/collection.js";
import {
  footnoteDefinitionPreamble,
  type MarkdownParseOutcome,
  type MarkdownTrees,
} from "#renderer/components/Markdown/parse/trees.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { startSlice } from "#renderer/lib/work-slices.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import {
  publishedTextOf,
  type PublishedText,
} from "#renderer/features/transcript/reveal/published-text.js";
import {
  withoutLeadingBlankLines,
  type MarkdownBlockRange,
  type MarkdownSegmentation,
} from "./parse/block-segmenter.js";
import { VolatileTailParser } from "./parse/volatile-tail.js";
import {
  fingerprintOf,
  FOOTNOTE_DEFINITION_LINE,
  type SettledMarkdownBlock,
} from "./settled-block.js";
import { holdsSameObjects } from "../../window/row-positions.js";

/** One body's blocks for one frame. */
export interface MarkdownBodyBlocksSnapshot {
  /** Counts the times the body's text was replaced rather than extended. */
  readonly generation: number;
  /**
   * The settled blocks drawn on their own, each from its tree: the same array until more are
   * drawn, a block's definitions land, or the generation changes.
   */
  readonly settledBlocks: readonly SettledMarkdownBlock[];
  /** The settled blocks that define a footnote: the ones whose definitions are registered. */
  readonly definingBlocks: readonly SettledMarkdownBlock[];
  /** The text drawn after `settledBlocks`: the volatile tail, with any block still moving out. */
  readonly volatileTail: string;
  /** The drawn tail's nodes, or `undefined` before the body's first draw. */
  readonly tailNodes: readonly RootContent[] | undefined;
  /** The tail's own footnote definitions, read from the tail alone; none in most frames. */
  readonly volatileTailDefinitions: readonly FootnoteDefinition[];
  /** Every identifier the body defines: the same set until one is added or removed. */
  readonly definedFootnoteIdentifiers: ReadonlySet<string>;
  /**
   * Those identifiers as the preamble every block is parsed after. A block still being read for
   * its definitions leaves it as it last stood; a drawn block keeps its tree until its parse
   * against the new one lands.
   */
  readonly definitionPreamble: string;
  /**
   * A settled block's text, cut from the body's text through its handle. The same function until
   * the generation changes, so a drawn block does not read its text again on a frame that only
   * grew the body; the cut is for a reader that lets it go, never one to keep.
   */
  readonly readBlockSource: (block: SettledMarkdownBlock) => string;
  /**
   * A drawn block's nodes, from the newest tree of it that has landed; the same array until a
   * newer one lands. Throws for a block that is not drawn.
   */
  readonly readBlockNodes: (block: SettledMarkdownBlock) => readonly RootContent[];
  /**
   * The definitions the drawn tree of block `index`, or of the tail past the settled blocks, was
   * parsed after: what every offset in that tree counts before the block's own text. Throws for a
   * settled block that is not drawn.
   */
  readonly readDefinitionPreamble: (index: number) => string;
}

/**
 * Holds one body's per-block reading and drawing across frames. Within a generation a block is
 * read when it settles and never again, so a frame costs its new blocks and its tail, not the
 * whole body. A block that could define a footnote is parsed alone once, and a tail that could is
 * parsed as it grows; the drawn tail is parsed as it grows, every settled block's tree is asked
 * for against the body's definitions once they are read, and held, and while settled blocks wait
 * to be drawn, the shorter tail is parsed too. `requestReads` asks for those parses after a frame
 * is drawn, and each that lands changes the snapshot, which `subscribe` hears.
 */
export class MarkdownBodyBlocks {
  readonly #trees: MarkdownTrees;
  /** Reads the tail alone, for the definitions it holds. */
  readonly #tailDefinitionParser: VolatileTailParser;
  readonly #changes = new Emitter<void>("markdown body blocks");
  /** Parses the tail that is drawn. */
  #drawnTail: HeldTailParser;
  /** Parses the shorter tail the body draws once its waiting blocks are drawn, while any wait. */
  #nextTail: HeldTailParser | undefined;
  /** Whether the drawn tail's tree is drawn: from the body's first draw on. */
  #isTailDrawn = false;
  /** The settled blocks that could define a footnote and whose parse has not landed. */
  readonly #unreadKeys = new Set<string>();
  /**
   * Lets go of each settled block's read for the footnotes it defines, by its key: its parse in
   * flight, or the tree it landed, held in the shared trees so a body mounted next reads it at once.
   */
  readonly #definitionReads = new Map<string, Unsubscribe>();
  /** The settled blocks whose definitions were read from a kept tree, not yet held. */
  readonly #keptDefinitionKeys = new Set<string>();
  /** Each settled block's tree as this body holds it, by the block's key. */
  #blockTrees = new Map<string, HeldBlockTree>();
  /**
   * What the last generation drew, kept on screen once the body's text is replaced until the new
   * generation's first draw, so a replaced body never blanks while its new trees are parsed.
   */
  #replaced: DrawnGeneration | undefined;
  /** How many settled blocks have had their trees asked for against `#treesAskedPreamble`. */
  #treesAskedCount = 0;
  #treesAskedPreamble: string | undefined;
  /** How many settled blocks are drawn on their own; the rest wait inside the drawn tail. */
  #drawnCount = 0;
  #drawnBlocks: readonly SettledMarkdownBlock[] = NO_BLOCKS;
  /** The settled blocks `#drawnBlocks` was cut from. */
  #drawnBlocksOf: readonly SettledMarkdownBlock[] = NO_BLOCKS;
  /** Counts the changes a landed parse made, which a snapshot is read against. */
  #revision = 0;
  #lastSegmentation: MarkdownSegmentation | undefined;
  #lastRevision = -1;
  #lastSnapshot: MarkdownBodyBlocksSnapshot | undefined;
  /** Whether the body's definitions were read when the last snapshot was. */
  #wereDefinitionsRead = false;
  #failure: string | undefined;
  #generation = -1;
  /** The current generation's text, which its blocks are cut from. */
  #generationText: GenerationText;
  #settledBlocks: readonly SettledMarkdownBlock[] = NO_BLOCKS;
  #definingBlocks: readonly SettledMarkdownBlock[] = NO_BLOCKS;
  #settledIdentifiers: ReadonlySet<string> = NO_IDENTIFIERS;
  /** The last union with the tail's identifiers, and the two sets it was made from. */
  #tailUnion: TailIdentifierUnion | undefined;
  #definitionPreamble = "";
  #preambleIdentifiers: ReadonlySet<string> = NO_IDENTIFIERS;
  /** The tail's tree its definitions were last read from, and those definitions. */
  #tailDefinitions: {
    readonly root: Root | undefined;
    readonly definitions: readonly FootnoteDefinition[];
  } = { root: undefined, definitions: NO_DEFINITIONS };

  /** How many changes landed parses have made; a new number means a new snapshot. */
  public readonly readRevision = (): number => this.#revision;

  /** Hear each change a landed parse makes. */
  public readonly subscribe = (listener: () => void): Unsubscribe =>
    this.#changes.subscribe(listener);

  readonly #readBlockNodes = (block: SettledMarkdownBlock): readonly RootContent[] =>
    this.#drawnTreeOf(block).nodes;

  public constructor(trees: MarkdownTrees) {
    this.#trees = trees;
    this.#tailDefinitionParser = new VolatileTailParser(trees);
    this.#generationText = new GenerationText();
    this.#tailDefinitionParser.subscribe(() => {
      this.#changed();
    });
    this.#drawnTail = this.#holdTailParser();
  }

  /**
   * The body's blocks for one segmentation; the last snapshot again for the same one while no
   * parse has landed since. What the shared trees keep is drawn at once, so a body whose trees
   * another holds draws in the commit it mounts. Throws when a parse this body needed failed.
   */
  public read(segmentation: MarkdownSegmentation): MarkdownBodyBlocksSnapshot {
    if (this.#failure !== undefined) {
      throw new Error(this.#failure);
    }
    if (
      segmentation === this.#lastSegmentation &&
      this.#revision === this.#lastRevision &&
      this.#lastSnapshot !== undefined
    ) {
      return this.#lastSnapshot;
    }
    this.#settle(segmentation);
    this.#generationText.update(segmentation.source);
    this.#readKeptDefinitions();
    const couldTailDefineFootnote = FOOTNOTE_DEFINITION_LINE.test(segmentation.volatileTail);
    if (couldTailDefineFootnote) {
      this.#tailDefinitionParser.showKept(segmentation.volatileTail, "");
    }
    const volatileTailDefinitions = couldTailDefineFootnote
      ? this.#readTailDefinitions()
      : NO_DEFINITIONS;
    const definedFootnoteIdentifiers = this.#unionWith(volatileTailDefinitions);
    if (definedFootnoteIdentifiers !== this.#preambleIdentifiers) {
      this.#preambleIdentifiers = definedFootnoteIdentifiers;
      this.#definitionPreamble = footnoteDefinitionPreamble(definedFootnoteIdentifiers);
    }
    const areDefinitionsRead = this.#areDefinitionsRead(segmentation);
    if (areDefinitionsRead && !this.#isTailDrawn) {
      this.#readKeptBlockTrees(this.#definitionPreamble);
      if (segmentation.volatileTail !== "") {
        this.#drawnTail.parser.showKept(segmentation.volatileTail, this.#definitionPreamble);
      }
    }
    const drawnTail = this.#drawWhatLanded(segmentation, areDefinitionsRead);
    const tailView = this.#drawnTail.parser.read();
    if (tailView?.status === "failed") {
      throw new Error(tailView.reason);
    }
    const drawnBlocks = this.#replaced?.settledBlocks ?? this.#drawnBlocks;
    const tailPreamble =
      this.#replaced === undefined
        ? tailView?.status === "parsed"
          ? tailView.definitionPreamble
          : undefined
        : this.#replaced.tailPreamble;
    const snapshot: MarkdownBodyBlocksSnapshot = {
      generation: this.#generation,
      settledBlocks: drawnBlocks,
      definingBlocks: this.#definingBlocks,
      volatileTail: drawnTail,
      tailNodes:
        this.#replaced?.tailNodes ??
        (drawnTail === "" || !this.#isTailDrawn ? undefined : tailView?.root.children),
      volatileTailDefinitions,
      definedFootnoteIdentifiers,
      definitionPreamble: this.#definitionPreamble,
      readBlockSource: this.#generationText.readBlockSource,
      readBlockNodes: this.#readBlockNodes,
      readDefinitionPreamble: (index) => {
        const block = drawnBlocks[index];
        return block === undefined ? (tailPreamble ?? "") : this.#drawnTreeOf(block).landedPreamble;
      },
    };
    this.#lastSegmentation = segmentation;
    this.#lastRevision = this.#revision;
    this.#lastSnapshot = snapshot;
    this.#wereDefinitionsRead = areDefinitionsRead;
    return snapshot;
  }

  /**
   * Ask for the parses the last snapshot is waiting on: each settled block that could define a
   * footnote and is not yet read, the tail while it could define one, the drawn tail, and once the
   * body's definitions are read, each settled block's tree not yet asked for against them and,
   * while settled blocks wait inside the drawn tail, the shorter tail's. Called after a frame is
   * drawn, never while one is, since a parse can land at once.
   */
  public requestReads(): void {
    const snapshot = this.#lastSnapshot;
    const segmentation = this.#lastSegmentation;
    if (snapshot === undefined || segmentation === undefined) {
      return;
    }
    for (const block of this.#settledBlocks) {
      if (this.#unreadKeys.has(block.key) && !this.#definitionReads.has(block.key)) {
        this.#requestDefinitions(block);
      } else if (this.#keptDefinitionKeys.delete(block.key)) {
        // Its definitions are read already, so what a parse of it comes to changes nothing here.
        this.#definitionReads.set(
          block.key,
          this.#trees.holdSettledBlock(
            this.#generationText.readBlockSource(block),
            "",
            () => undefined,
          ),
        );
      }
    }
    if (FOOTNOTE_DEFINITION_LINE.test(segmentation.volatileTail)) {
      this.#tailDefinitionParser.update(segmentation.volatileTail, "");
    }
    const preamble = snapshot.definitionPreamble;
    // As the snapshot read them: a read that lands while this asks changes its preamble.
    const areDefinitionsRead = this.#wereDefinitionsRead;
    // A drawn tail keeps growing while a block is read for its definitions; before the first draw
    // nothing is asked against definitions about to change.
    if (snapshot.volatileTail !== "" && (this.#isTailDrawn || areDefinitionsRead)) {
      this.#drawnTail.parser.update(snapshot.volatileTail, preamble);
    }
    if (!areDefinitionsRead) {
      return;
    }
    if (preamble !== this.#treesAskedPreamble) {
      this.#treesAskedPreamble = preamble;
      this.#treesAskedCount = 0;
    }
    // Asked from where the last ask stopped, so a frame costs the blocks settled since, and for a
    // slice at most once one is waiting: the tree that lands asks for the next slice, so a long
    // reply read back asks for its thousands of trees across tasks.
    const hasTime = startSlice();
    const blocks = this.#settledBlocks;
    let isWaiting = false;
    for (; this.#treesAskedCount < blocks.length; this.#treesAskedCount += 1) {
      const block = blocks[this.#treesAskedCount];
      if (isWaiting && !hasTime()) {
        break;
      }
      if (block !== undefined && this.#blockTrees.get(block.key)?.askedPreamble !== preamble) {
        isWaiting = this.#requestBlockTree(block, preamble) || isWaiting;
      }
    }
    if (!this.#isTailDrawn || this.#drawnCount === this.#settledBlocks.length) {
      return;
    }
    if (segmentation.volatileTail !== "") {
      this.#nextTail ??= this.#holdTailParser();
      this.#nextTail.parser.update(segmentation.volatileTail, preamble);
    }
  }

  /**
   * Stop listening for every parse in flight and let go of the trees held in the shared trees, as
   * the body leaves the screen. The trees that landed stay held here, so a body mounted again
   * draws them at once and asks only for the rest.
   */
  public close(): void {
    for (const letGo of this.#definitionReads.values()) {
      letGo();
    }
    this.#definitionReads.clear();
    this.#tailDefinitionParser.close();
    this.#dropNextTail();
    this.#drawnTail.parser.close();
    for (const [key, held] of this.#blockTrees) {
      held.stop();
      held.letLandedGo();
      held.letLandedGo = NO_STOP;
      if (held.nodes === undefined) {
        this.#blockTrees.delete(key);
      } else {
        held.askedPreamble = held.landedPreamble;
        held.stop = NO_STOP;
      }
    }
    this.#treesAskedCount = 0;
  }

  /**
   * Draw what the segmentation settled as far as its trees allow, and answer the tail drawn after
   * the drawn blocks. Before the body's first draw nothing is on screen to keep, so the tail is
   * the segmentation's own, and every settled block is drawn with it once the body's definitions
   * are read and every block's tree and the tail's have landed against them; after it, the waiting
   * blocks move out of the tail only together, once the definitions are read and their trees and
   * the shorter tail's have landed.
   */
  #drawWhatLanded(segmentation: MarkdownSegmentation, areDefinitionsRead: boolean): string {
    const settledCount = this.#settledBlocks.length;
    if (!this.#isTailDrawn) {
      const tailView = this.#drawnTail.parser.read();
      if (
        areDefinitionsRead &&
        this.#haveBlockTreesLanded() &&
        (segmentation.volatileTail === "" ||
          (tailView?.status === "parsed" &&
            tailView.definitionPreamble === this.#definitionPreamble))
      ) {
        this.#drawnCount = settledCount;
        this.#isTailDrawn = true;
        this.#replaced = undefined;
      }
    } else if (
      this.#drawnCount < settledCount &&
      areDefinitionsRead &&
      this.#haveWaitingBlocksLanded(segmentation)
    ) {
      this.#drawnCount = settledCount;
      this.#drawnTail.stop();
      this.#drawnTail = this.#nextTail ?? this.#holdTailParser();
      this.#nextTail = undefined;
    }
    if (
      this.#drawnBlocksOf !== this.#settledBlocks ||
      this.#drawnBlocks.length !== this.#drawnCount
    ) {
      this.#drawnBlocksOf = this.#settledBlocks;
      const drawn = this.#settledBlocks.slice(0, this.#drawnCount);
      // A block settling behind the drawn ones leaves them the same array.
      if (!holdsSameObjects(drawn, this.#drawnBlocks)) {
        this.#drawnBlocks = drawn;
      }
    }
    return this.#drawnCount === settledCount || !this.#isTailDrawn
      ? segmentation.volatileTail
      : this.#tailFrom(segmentation, this.#settledBlocks[this.#drawnCount]);
  }

  /**
   * Whether the body's definitions are read: every settled block that could define a footnote has
   * been, and the tail too while it could define one.
   */
  #areDefinitionsRead(segmentation: MarkdownSegmentation): boolean {
    return (
      this.#unreadKeys.size === 0 &&
      (!FOOTNOTE_DEFINITION_LINE.test(segmentation.volatileTail) ||
        this.#tailDefinitionParser.read() !== undefined)
    );
  }

  /** Whether every settled block not yet drawn has its tree against the body's definitions. */
  #haveBlockTreesLanded(): boolean {
    for (const block of this.#settledBlocks.slice(this.#drawnCount)) {
      if (this.#blockTrees.get(block.key)?.landedPreamble !== this.#definitionPreamble) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether every waiting block's tree has landed against the preamble, and the shorter tail's
   * tree reaches at least as far into the text as the drawn tail's: measured from the text's end,
   * it leaves no more characters undrawn.
   */
  #haveWaitingBlocksLanded(segmentation: MarkdownSegmentation): boolean {
    if (!this.#haveBlockTreesLanded()) {
      return false;
    }
    const tail = segmentation.volatileTail;
    if (tail === "") {
      return true;
    }
    const next = this.#nextTail?.parser.read();
    const drawn = this.#drawnTail.parser.read();
    if (next?.status !== "parsed" || drawn?.status !== "parsed") {
      return false;
    }
    const drawnTail = this.#tailFrom(segmentation, this.#settledBlocks[this.#drawnCount]);
    return (
      tail.startsWith(next.tailSource) &&
      drawnTail.startsWith(drawn.tailSource) &&
      tail.length - next.tailSource.length <= drawnTail.length - drawn.tailSource.length
    );
  }

  /** The body's text from `block` on, as a tail is drawn: without its leading blank lines. */
  #tailFrom(segmentation: MarkdownSegmentation, block: SettledMarkdownBlock | undefined): string {
    if (block === undefined) {
      return segmentation.volatileTail;
    }
    const source = segmentation.source;
    // A copy, as the segmenter's tail is: a tail parser keeps what it read across frames.
    return structuredClone(withoutLeadingBlankLines(source.slice(block.start, source.length)));
  }

  /** Stop listening for the shorter tail's parse. */
  #dropNextTail(): void {
    this.#nextTail?.stop();
    this.#nextTail = undefined;
  }

  /** A new tail parser whose every change is this body's. */
  #holdTailParser(): HeldTailParser {
    const parser = new VolatileTailParser(this.#trees);
    const unsubscribe = parser.subscribe(() => {
      this.#changed();
    });
    return {
      parser,
      stop: () => {
        unsubscribe();
        parser.close();
      },
    };
  }

  /** Asks for `block`'s tree against `definitionPreamble`; answers whether the ask is waiting. */
  #requestBlockTree(block: SettledMarkdownBlock, definitionPreamble: string): boolean {
    const held = this.#blockTrees.get(block.key) ?? {
      askedPreamble: definitionPreamble,
      landedPreamble: undefined,
      nodes: undefined,
      stop: NO_STOP,
      letLandedGo: NO_STOP,
    };
    held.stop();
    held.stop = NO_STOP;
    held.askedPreamble = definitionPreamble;
    this.#blockTrees.set(block.key, held);
    let answeredAtOnce: MarkdownParseOutcome | undefined;
    let isAsking = true;
    const letGo = this.#trees.holdSettledBlock(
      this.#generationText.readBlockSource(block),
      definitionPreamble,
      (outcome) => {
        if (isAsking) {
          answeredAtOnce = outcome;
          return;
        }
        this.#landBlockTree(held, definitionPreamble, outcome, letGo);
      },
    );
    isAsking = false;
    // A kept tree, or a stand-in parser's, is answered before the ask returns.
    if (answeredAtOnce === undefined) {
      held.stop = letGo;
      return true;
    }
    this.#landBlockTree(held, definitionPreamble, answeredAtOnce, letGo);
    return false;
  }

  /**
   * Reads the footnotes each settled block not yet read defines from a tree the shared trees keep,
   * so a body whose trees another holds draws on its first frame; `requestReads` holds them.
   */
  #readKeptDefinitions(): void {
    for (const block of this.#settledBlocks) {
      if (!this.#unreadKeys.has(block.key) || this.#definitionReads.has(block.key)) {
        continue;
      }
      const kept = this.#trees.readSettledBlock(this.#generationText.readBlockSource(block), "");
      if (kept !== undefined) {
        this.#readDefinitions(block, kept.root);
        this.#keptDefinitionKeys.add(block.key);
      }
    }
  }

  /**
   * Takes the tree the shared trees keep of each block not drawn and not yet asked for against
   * `definitionPreamble`; `requestReads` asks for it, and holds it, as for any other.
   */
  #readKeptBlockTrees(definitionPreamble: string): void {
    for (const block of this.#settledBlocks.slice(this.#drawnCount)) {
      const held = this.#blockTrees.get(block.key);
      if (
        held?.askedPreamble === definitionPreamble ||
        held?.landedPreamble === definitionPreamble
      ) {
        continue;
      }
      const kept = this.#trees.readSettledBlock(
        this.#generationText.readBlockSource(block),
        definitionPreamble,
      );
      if (kept === undefined) {
        continue;
      }
      if (held === undefined) {
        this.#blockTrees.set(block.key, {
          askedPreamble: undefined,
          landedPreamble: definitionPreamble,
          nodes: kept.root.children,
          stop: NO_STOP,
          letLandedGo: NO_STOP,
        });
      } else {
        held.nodes = kept.root.children;
        held.landedPreamble = definitionPreamble;
      }
    }
  }

  /** Takes a block's landed tree, held in the shared trees in place of its last one. */
  #landBlockTree(
    held: HeldBlockTree,
    definitionPreamble: string,
    outcome: MarkdownParseOutcome,
    letGo: Unsubscribe,
  ): void {
    held.stop = NO_STOP;
    if (outcome.status === "failed") {
      this.#failure = outcome.reason;
      this.#changed();
      return;
    }
    held.letLandedGo();
    held.letLandedGo = letGo;
    // The tree a read drew from the shared trees, now held, changes nothing drawn.
    if (held.nodes === outcome.root.children && held.landedPreamble === definitionPreamble) {
      return;
    }
    held.nodes = outcome.root.children;
    held.landedPreamble = definitionPreamble;
    this.#changed();
  }

  #requestDefinitions(block: SettledMarkdownBlock): void {
    let answeredAtOnce: MarkdownParseOutcome | undefined;
    let isAsking = true;
    const letGo = this.#trees.holdSettledBlock(
      this.#generationText.readBlockSource(block),
      "",
      (outcome) => {
        if (isAsking) {
          answeredAtOnce = outcome;
          return;
        }
        this.#landDefinitions(block, outcome);
      },
    );
    isAsking = false;
    this.#definitionReads.set(block.key, letGo);
    // A kept tree, or a stand-in parser's, is answered before the ask returns.
    if (answeredAtOnce !== undefined) {
      this.#landDefinitions(block, answeredAtOnce);
    }
  }

  #landDefinitions(block: SettledMarkdownBlock, outcome: MarkdownParseOutcome): void {
    if (outcome.status === "failed") {
      this.#failure = outcome.reason;
    } else {
      this.#readDefinitions(block, outcome.root);
    }
    this.#changed();
  }

  /** Takes the footnotes a settled block defines from its tree parsed alone. */
  #readDefinitions(block: SettledMarkdownBlock, root: Root): void {
    const index = this.#settledBlocks.indexOf(block);
    if (index === -1) {
      return;
    }
    this.#unreadKeys.delete(block.key);
    const definedFootnoteIdentifiers = collectFootnoteDefinitions(root.children).definedIdentifiers;
    if (definedFootnoteIdentifiers.size > 0) {
      const read = { ...block, definedFootnoteIdentifiers };
      this.#settledBlocks = this.#settledBlocks.with(index, read);
      this.#definingBlocks = this.#settledBlocks.filter(
        (settled) => settled.definedFootnoteIdentifiers.size > 0,
      );
      this.#settledIdentifiers = identifiersOf(this.#definingBlocks);
    }
  }

  /** The tail's definitions from the tree its parser shows, read again only when that changes. */
  #readTailDefinitions(): readonly FootnoteDefinition[] {
    const view = this.#tailDefinitionParser.read();
    if (view?.status === "failed") {
      throw new Error(view.reason);
    }
    if (view === undefined) {
      return NO_DEFINITIONS;
    }
    if (view.root !== this.#tailDefinitions.root) {
      this.#tailDefinitions = {
        root: view.root,
        definitions: collectFootnoteDefinitions(view.root.children).definitions,
      };
    }
    return this.#tailDefinitions.definitions;
  }

  /**
   * A drawn block's newest landed tree, from this generation or the replaced one still on screen.
   * Throws for a block that is not drawn.
   */
  #drawnTreeOf(block: SettledMarkdownBlock): LandedBlockTree {
    const held = this.#blockTrees.get(block.key);
    if (held !== undefined && hasLanded(held)) {
      return held;
    }
    const replaced = this.#replaced?.blockTrees.get(block.key);
    if (replaced !== undefined && hasLanded(replaced)) {
      return replaced;
    }
    throw new Error(`The block at ${String(block.start)} was drawn before its tree landed`);
  }

  #changed(): void {
    this.#revision += 1;
    this.#changes.emit();
  }

  /** Brings the settled blocks up to the segmentation, reading only the ones not read before. */
  #settle(segmentation: MarkdownSegmentation): void {
    const ranges = segmentation.settledBlocks;
    if (segmentation.generation !== this.#generation) {
      this.#generation = segmentation.generation;
      // A new reader, so no block of the last generation is cut from this one's text.
      this.#generationText = new GenerationText();
      this.#settledBlocks = NO_BLOCKS;
      this.#definingBlocks = NO_BLOCKS;
      this.#settledIdentifiers = NO_IDENTIFIERS;
      this.close();
      this.#unreadKeys.clear();
      this.#keptDefinitionKeys.clear();
      if (this.#isTailDrawn) {
        const tailView = this.#drawnTail.parser.read();
        this.#replaced = {
          settledBlocks: this.#drawnBlocks,
          tailNodes: this.#lastSnapshot?.tailNodes,
          tailPreamble: tailView?.status === "parsed" ? tailView.definitionPreamble : undefined,
          blockTrees: this.#blockTrees,
        };
      }
      this.#blockTrees = new Map();
      this.#drawnCount = 0;
      this.#isTailDrawn = false;
      this.#drawnTail.stop();
      this.#drawnTail = this.#holdTailParser();
    }
    const heldCount = this.#settledBlocks.length;
    if (ranges.length === heldCount) {
      return;
    }
    if (ranges.length < heldCount) {
      // A body marked finished and then streaming again holds its last blocks back once more.
      for (const dropped of this.#settledBlocks.slice(ranges.length)) {
        this.#definitionReads.get(dropped.key)?.();
        this.#definitionReads.delete(dropped.key);
        this.#unreadKeys.delete(dropped.key);
        this.#keptDefinitionKeys.delete(dropped.key);
        const droppedTree = this.#blockTrees.get(dropped.key);
        droppedTree?.stop();
        droppedTree?.letLandedGo();
        this.#blockTrees.delete(dropped.key);
      }
      this.#settledBlocks = this.#settledBlocks.slice(0, ranges.length);
      this.#definingBlocks = this.#settledBlocks.filter(
        (block) => block.definedFootnoteIdentifiers.size > 0,
      );
      this.#settledIdentifiers = identifiersOf(this.#definingBlocks);
      // The blocks given back join the tail, which no tree on screen covers yet.
      this.#drawnCount = Math.min(this.#drawnCount, ranges.length);
      this.#treesAskedCount = Math.min(this.#treesAskedCount, ranges.length);
      this.#isTailDrawn = false;
      this.#dropNextTail();
      this.#drawnTail.stop();
      this.#drawnTail = this.#holdTailParser();
      return;
    }
    const settledBlocks = [...this.#settledBlocks];
    for (const [offset, range] of ranges.slice(heldCount).entries()) {
      const { block, couldDefineFootnote } = readSettledBlock(
        segmentation.source,
        range,
        heldCount + offset,
      );
      settledBlocks.push(block);
      if (couldDefineFootnote) {
        this.#unreadKeys.add(block.key);
      }
    }
    this.#settledBlocks = settledBlocks;
  }
  /**
   * The settled identifiers with the tail's, as the same set while neither changed: the set's
   * identity is what keeps every drawn block from re-rendering on a frame that added none.
   */
  #unionWith(tailDefinitions: readonly FootnoteDefinition[]): ReadonlySet<string> {
    const settled = this.#settledIdentifiers;
    const tailOnly = [
      ...new Set(tailDefinitions.map((definition) => definition.identifier)),
    ].filter((identifier) => !settled.has(identifier));
    if (tailOnly.length === 0) {
      this.#tailUnion = undefined;
      return settled;
    }
    const tailOnlyKey = tailOnly.sort().join(IDENTIFIER_SEPARATOR);
    const held = this.#tailUnion;
    if (held?.settled === settled && held.tailOnly === tailOnlyKey) {
      return held.identifiers;
    }
    const identifiers = new Set([...settled, ...tailOnly]);
    this.#tailUnion = { settled, tailOnly: tailOnlyKey, identifiers };
    return identifiers;
  }
}

/**
 * Where block `index` of a body starts in the body's text, in UTF-16 code units: a settled block's
 * own start, or the tail's, which runs to the body's end.
 */
export function blockSourceStartOf(
  blocks: Pick<MarkdownBodyBlocksSnapshot, "settledBlocks" | "volatileTail">,
  bodyTextLength: number,
  index: number,
): number {
  return blocks.settledBlocks[index]?.start ?? bodyTextLength - blocks.volatileTail.length;
}

/** One generation's text, as the handle it is read through: every block of it is cut from this. */
class GenerationText {
  #text: PublishedText = NO_TEXT;

  /** A block's text, cut from the generation's text, which only ever grew. */
  public readonly readBlockSource = (block: SettledMarkdownBlock): string =>
    this.#text.slice(block.start, block.end);

  public update(text: PublishedText): void {
    this.#text = text;
  }
}

/** What one generation drew: its drawn blocks, its tail's nodes, and the trees they are drawn from. */
interface DrawnGeneration {
  readonly settledBlocks: readonly SettledMarkdownBlock[];
  readonly tailNodes: readonly RootContent[] | undefined;
  /** The definitions the tail's drawn tree was parsed after. */
  readonly tailPreamble: string | undefined;
  readonly blockTrees: ReadonlyMap<string, HeldBlockTree>;
}

/** A tail parser this body holds, and the stop that lets it go. */
interface HeldTailParser {
  readonly parser: VolatileTailParser;
  readonly stop: Unsubscribe;
}

/** One settled block's tree as its body holds it. */
interface HeldBlockTree {
  /** The definitions its newest ask was parsed against. */
  askedPreamble: string | undefined;
  /** The definitions its newest landed tree was parsed against, `undefined` before one lands. */
  landedPreamble: string | undefined;
  /** Its newest landed tree's nodes. */
  nodes: readonly RootContent[] | undefined;
  /** Stops listening for its ask in flight. */
  stop: Unsubscribe;
  /** Lets go of its newest landed tree, held in the shared trees while this body holds it. */
  letLandedGo: Unsubscribe;
}

/** A block's tree once one has landed. */
interface LandedBlockTree extends HeldBlockTree {
  landedPreamble: string;
  nodes: readonly RootContent[];
}

function hasLanded(held: HeldBlockTree): held is LandedBlockTree {
  return held.nodes !== undefined && held.landedPreamble !== undefined;
}

/** The tail's identifiers the settled blocks do not define, with the union they made. */
interface TailIdentifierUnion {
  readonly settled: ReadonlySet<string>;
  /** The tail-only identifiers, sorted and joined. */
  readonly tailOnly: string;
  readonly identifiers: ReadonlySet<string>;
}

/**
 * What joins identifiers into one comparison key. NUL, because commonmark replaces a literal NUL
 * in a label with U+FFFD, so no identifier holds one.
 */
const IDENTIFIER_SEPARATOR = "\u0000";

const NO_BLOCKS: readonly SettledMarkdownBlock[] = Object.freeze([]);
const NO_DEFINITIONS: readonly FootnoteDefinition[] = Object.freeze([]);
const NO_IDENTIFIERS: ReadonlySet<string> = new Set<string>();
const NO_TEXT: PublishedText = publishedTextOf("");
const NO_STOP: Unsubscribe = () => undefined;

/**
 * One block read as it settles: its key and fingerprint, and whether it could define a footnote,
 * which only its own parse can say.
 */
function readSettledBlock(
  bodyText: PublishedText,
  range: MarkdownBlockRange,
  index: number,
): { readonly block: SettledMarkdownBlock; readonly couldDefineFootnote: boolean } {
  // Read here and let go: the record keeps only the range.
  const text = bodyText.slice(range.start, range.end);
  const fingerprint = fingerprintOf(text);
  return {
    block: {
      key: `${String(index)}:${fingerprint}`,
      fingerprint,
      start: range.start,
      end: range.end,
      definedFootnoteIdentifiers: NO_IDENTIFIERS,
    },
    couldDefineFootnote: FOOTNOTE_DEFINITION_LINE.test(text),
  };
}

/** Every identifier these blocks define. */
function identifiersOf(blocks: readonly SettledMarkdownBlock[]): ReadonlySet<string> {
  return blocks.length === 0
    ? NO_IDENTIFIERS
    : new Set(blocks.flatMap((block) => [...block.definedFootnoteIdentifiers]));
}
