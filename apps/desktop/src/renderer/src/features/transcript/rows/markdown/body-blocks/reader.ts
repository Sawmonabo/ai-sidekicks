// One markdown body's blocks, as its renderer keys, windows, resolves and draws them. The worker
// cuts the body's text where the parser's own top-level blocks start: a whole text at once, and a
// streaming one first up to its last few blocks, then from the parse of its tail, which settles
// every block but its last two. Each block is recorded once, as it settles, and its text cut again
// from the body's text when it is read, so a long reply is held once. A block that could define a
// footnote or a link is read alone, once, for what it defines. A mounted block is parsed on the
// page the frame it mounts, against the definitions the whole body declares, and its tree kept only
// while it is mounted; the worker parses a block too long for the page, held while the body lives,
// the tail as it grows, and every block while the page's parser could not start.
//
// What is drawn moves in one step. A body's first draw waits until its text is cut, the page's
// parser can parse (or failed to start), the body's definitions are read, and every tree the worker
// parses and the tail's have landed against them. After that, a block that settles stays inside
// the drawn tail, which keeps growing, while its tree, if the worker parses it, and the shorter
// tail's tree are parsed behind it; the body draws the block on its own only once both have landed
// and the shorter tail covers every character the drawn one did. So no frame draws a block without
// its tree, draws a block's text twice, or draws fewer characters than the frame before.

import type { FootnoteDefinition, Root, RootContent } from "mdast";

import { collectFootnoteDefinitions } from "#renderer/components/Markdown/footnotes/collection.js";
import type {
  MarkdownParseOutcome,
  MarkdownTrees,
  ParsedMarkdown,
} from "#renderer/components/Markdown/parse/trees.js";
import { Emitter } from "#renderer/lib/emitter.js";
import { startSlice } from "#renderer/lib/work-slices.js";
import type { Unsubscribe } from "#shared/preload-api.js";
import type { PublishedText } from "#renderer/features/transcript/reveal/published-text.js";
import { VolatileTailParser } from "../parse/volatile-tail.js";
import { LINK_DEFINITION_LINE } from "../settled-block.js";
import {
  definitionsOf,
  NO_DEFINITIONS,
  type DefinitionsView,
  type ReadDefinitions,
} from "./definitions.js";
import { BlockGeneration, NO_STOP, type HeldBlockTree } from "./generation.js";
import { type MarkdownBodyBlocksSnapshot } from "./snapshot.js";

/**
 * Holds one body's cut, reading and drawing across frames. A block is recorded when it settles and
 * read for its definitions once, so a frame costs its new blocks and its tail, not the whole body.
 * `requestReads` asks for the parses and the cut the last snapshot waits on, after a frame is
 * drawn, and each that lands changes the snapshot, which `subscribe` hears.
 */
export class MarkdownBodyBlocks {
  readonly #trees: MarkdownTrees;
  /** Reads the tail alone, for the definitions it holds. */
  readonly #tailDefinitionParser: VolatileTailParser;
  readonly #changes = new Emitter<void>("markdown body blocks");
  /** Stops hearing the page's parser, while anything hears this body. */
  #stopHearingPageParser: Unsubscribe | undefined;
  /** Parses the tail that is drawn. */
  #drawnTail: HeldTailParser;
  /** Parses the shorter tail the body draws once its waiting blocks are drawn, while any wait. */
  #nextTail: HeldTailParser | undefined;
  /** Whether the drawn tail's tree is drawn: from the body's first draw on. */
  #isTailDrawn = false;
  #generation: BlockGeneration;
  /**
   * What the last generation drew, kept on screen once the body's text is replaced until the new
   * generation's first draw, so a replaced body never blanks while its new trees are parsed.
   */
  #replaced: DrawnGeneration | undefined;
  /** How many blocks are drawn on their own; the rest wait inside the drawn tail. */
  #drawnCount = 0;
  /** How far the worker's trees were asked for, and against which definitions and mode. */
  #treesAsked: TreesAsked | undefined;
  /** The mode the last read parsed in. */
  #mode: ParseMode = "waiting";
  /** Counts the changes a landed parse or cut made, which a snapshot is read against. */
  #revision = 0;
  #last: LastRead | undefined;
  #failure: string | undefined;
  /** The tail's tree its definitions were last read from, and what it defines. */
  #tailDefinitions: TailDefinitions = { root: undefined, read: NO_DEFINITIONS, footnotes: [] };
  /** The drawn blocks that define a footnote, as last cut from the definitions' list. */
  #definingDrawn: DefiningDrawn = { of: [], count: 0, blocks: [] };

  /** How many changes landed parses have made; a new number means a new snapshot. */
  public readonly readRevision = (): number => this.#revision;

  /** Hear each change a landed parse, a cut or the page's parser makes. */
  public readonly subscribe = (listener: () => void): Unsubscribe => {
    const stop = this.#changes.subscribe(listener);
    this.#stopHearingPageParser ??= this.#trees.pageParser.subscribe(() => {
      this.#changed();
    });
    return () => {
      stop();
      if (!this.#changes.hasSinks) {
        this.#stopHearingPageParser?.();
        this.#stopHearingPageParser = undefined;
      }
    };
  };

  public constructor(trees: MarkdownTrees) {
    this.#trees = trees;
    this.#tailDefinitionParser = new VolatileTailParser(trees);
    this.#tailDefinitionParser.subscribe(() => {
      this.#changed();
    });
    this.#generation = new BlockGeneration(0);
    this.#drawnTail = this.#holdTailParser();
  }

  /**
   * The body's blocks for its text as it stands, finished when `isComplete`; the last snapshot
   * again for the same text while nothing has landed since. What can be read at once is: a body
   * whose tail another holds draws in the commit it mounts. Throws when a parse or a cut this body
   * needed failed.
   */
  public read(text: PublishedText, isComplete: boolean): MarkdownBodyBlocksSnapshot {
    if (this.#failure !== undefined) {
      throw new Error(this.#failure);
    }
    const last = this.#last;
    if (
      last?.text === text &&
      last.textRevision === text.revision &&
      last.isComplete === isComplete &&
      last.revision === this.#revision
    ) {
      return last.snapshot;
    }
    const mode = this.#readMode();
    const cutState = this.#follow(text, isComplete);
    const generation = this.#generation;
    const tail = this.#tailOf(text, cutState);
    this.#readDefinitionsNow(mode);
    const couldTailDefine = LINK_DEFINITION_LINE.test(tail);
    if (couldTailDefine) {
      this.#tailDefinitionParser.showKept(tail, "");
    }
    const tailDefinitions = couldTailDefine ? this.#readTailDefinitions() : NO_TAIL_DEFINITIONS;
    const definitions = generation.definitions.withTail(tailDefinitions.read);
    const areDefinitionsRead =
      generation.definitions.unread.size === 0 &&
      (!couldTailDefine || this.#tailDefinitionParser.read() !== undefined);
    const canDraw = cutState !== "cutting" && mode !== "waiting";
    if (canDraw && areDefinitionsRead && !this.#isTailDrawn) {
      this.#readKeptBlockTrees(mode, definitions);
      if (tail !== "") {
        this.#drawnTail.parser.showKept(tail, definitions.tailPreamble);
      }
    }
    const drawnTail = canDraw
      ? this.#drawWhatLanded(mode, definitions, areDefinitionsRead, tail)
      : this.#tailWhileCutting(tail);
    const tailView = this.#drawnTail.parser.read();
    if (tailView?.status === "failed") {
      throw new Error(tailView.reason);
    }
    const current: DrawnGeneration = {
      generation,
      view: definitions,
      drawnCount: this.#drawnCount,
      volatileTail: drawnTail,
      tailNodes: drawnTail === "" || !this.#isTailDrawn ? undefined : tailView?.root.children,
      tailPreamble: tailView?.status === "parsed" ? tailView.definitionPreamble : undefined,
    };
    const snapshot = this.#snapshotOf(this.#replaced ?? current, definitions, tailDefinitions);
    this.#last = {
      text,
      textRevision: text.revision,
      isComplete,
      revision: this.#revision,
      snapshot,
      current,
      mode,
      cutState,
      tail,
      areDefinitionsRead,
    };
    return snapshot;
  }

  /**
   * Ask for the cut and the parses the last snapshot is waiting on: the text's cut while it waits
   * on one; each block that could define something and the page does not read; the tail while it
   * could define something; the drawn tail; and once the body's definitions are read, each tree
   * the worker parses not yet asked for against them and, while blocks wait inside the drawn tail,
   * the shorter tail's. Called after a frame is drawn, never while one is, since an answer can land
   * at once.
   */
  public requestReads(): void {
    const last = this.#last;
    if (last === undefined) {
      return;
    }
    const generation = this.#generation;
    const { mode, cutState } = last;
    if (mode === "waiting" && this.#trees.pageParser.state === "idle") {
      this.#trees.wakeWorker();
    }
    if (cutState === "cutting" && generation.cutInFlight === undefined) {
      this.#requestCut(generation, last.text, last.isComplete);
    }
    for (const index of [...generation.definitions.unread]) {
      if (this.#needsWorker(generation, index, mode) && !generation.definitionReads.has(index)) {
        this.#requestDefinitions(generation, index);
      }
    }
    if (cutState === "cutting") {
      return;
    }
    if (LINK_DEFINITION_LINE.test(last.tail)) {
      this.#tailDefinitionParser.update(last.tail, "");
    }
    const definitions = last.current.view;
    const drawnTail = last.current.volatileTail;
    // A drawn tail keeps growing while a block is read for its definitions; before the first draw
    // nothing is asked against definitions about to change.
    if (drawnTail !== "" && (this.#isTailDrawn || last.areDefinitionsRead)) {
      this.#drawnTail.parser.update(drawnTail, definitions.tailPreamble);
    }
    if (!last.areDefinitionsRead) {
      return;
    }
    this.#requestWorkerTrees(generation, mode, definitions);
    if (!this.#isTailDrawn || this.#drawnCount === generation.records.count) {
      return;
    }
    if (last.tail !== "") {
      this.#nextTail ??= this.#holdTailParser();
      this.#nextTail.parser.update(last.tail, definitions.tailPreamble);
    }
  }

  /** Lets go of every page tree, as the body leaves the screen; its blocks parse again on mount. */
  public letPageTreesGo(): void {
    this.#generation.letPageTreesGo();
    this.#replaced?.generation.letPageTreesGo();
  }

  /**
   * Stop listening for every parse and cut in flight and let go of the trees held in the shared
   * trees, as the body's row is let go. The trees that landed stay held here, so a body read again
   * draws them at once and asks only for the rest.
   */
  public close(): void {
    this.#tailDefinitionParser.close();
    this.#dropNextTail();
    this.#drawnTail.parser.close();
    this.#generation.stopAsks();
    this.#replaced?.generation.stopAsks();
    this.#treesAsked = undefined;
    this.letPageTreesGo();
  }

  /** How the body's blocks are parsed now, from the page's parser's state. */
  #readMode(): ParseMode {
    const state = this.#trees.pageParser.state;
    const mode: ParseMode = state === "ready" ? "page" : state === "failed" ? "worker" : "waiting";
    if (mode === "page" && this.#mode === "worker") {
      // The page parses what the worker parsed for it while it could not.
      const generation = this.#generation;
      for (const [index, held] of generation.workerTrees) {
        if (!generation.isOverPageCap(index)) {
          held.stop();
          held.letLandedGo();
          generation.workerTrees.delete(index);
        }
      }
    }
    this.#mode = mode;
    return mode;
  }

  /**
   * Brings the generation up to `text`: a text that does not extend the one read starts a new
   * generation; a whole cut the text outgrew, or that a stream reopened, gives its last blocks
   * back; and a streaming tail's parses settle the blocks they can. Answers where the cut stands.
   */
  #follow(text: PublishedText, isComplete: boolean): CutState {
    if (!this.#generation.isExtendedBy(text)) {
      this.#replaceGeneration();
    }
    const generation = this.#generation;
    generation.take(text);
    if (generation.hasWholeCut && !(isComplete && generation.isCutWhole(text.length))) {
      this.#giveBack(generation.reopenWholeCut());
    }
    if (isComplete) {
      return generation.isCutWhole(text.length) ? "whole" : "cutting";
    }
    if (!generation.hasCut && !this.#isTailDrawn) {
      return "cutting";
    }
    if (this.#isTailDrawn) {
      this.#settleFromTails(generation);
    }
    return "streaming";
  }

  /**
   * Records the blocks a tail's parse settled, from either tail parser whose tree was parsed from
   * the text after the blocks cut so far; each lands as text that only grew, so its blocks are the
   * text's.
   */
  #settleFromTails(generation: BlockGeneration): void {
    for (;;) {
      const cutEnd = generation.cutEnd;
      const tail = generation.tailFrom(cutEnd);
      const tailStart = generation.text.length - tail.length;
      const view = [this.#drawnTail.parser.read(), this.#nextTail?.parser.read()].find(
        (candidate) =>
          candidate?.status === "parsed" &&
          candidate.settledBlockEnds.length > 0 &&
          tail.startsWith(candidate.tailSource),
      );
      if (view?.status !== "parsed") {
        return;
      }
      generation.appendBlocks(view.settledBlockEnds.map((end) => tailStart + end));
    }
  }

  /** The text past the blocks cut, as the tail parses it: none once the text is cut whole. */
  #tailOf(text: PublishedText, cutState: CutState): string {
    if (cutState === "whole") {
      return "";
    }
    if (cutState === "cutting") {
      // A drawn body keeps the tail it drew until the cut lands: a finished text is never parsed
      // as a tail, whose mending would close what its author left open.
      return this.#isTailDrawn ? (this.#last?.tail ?? "") : "";
    }
    return this.#generation.tailFrom(this.#generation.cutEnd);
  }

  /** What a drawn body shows while its text is cut: the tail it drew. */
  #tailWhileCutting(tail: string): string {
    return this.#isTailDrawn ? (this.#last?.current.volatileTail ?? tail) : tail;
  }

  /** Starts a new generation for a text that does not extend the last. */
  #replaceGeneration(): void {
    const previous = this.#generation;
    previous.stopAsks();
    if (this.#isTailDrawn && this.#last !== undefined) {
      previous.records.markReplaced();
      this.#replaced?.generation.letGo();
      this.#replaced = { ...this.#last.current, generation: previous };
    } else if (this.#replaced?.generation !== previous) {
      previous.letGo();
    }
    this.#generation = new BlockGeneration(previous.number + 1);
    this.#drawnCount = 0;
    this.#isTailDrawn = false;
    this.#treesAsked = undefined;
    this.#dropNextTail();
    this.#drawnTail.stop();
    this.#drawnTail = this.#holdTailParser();
  }

  /** Gives the blocks from `count` on back to the tail, which no tree on screen covers yet. */
  #giveBack(count: number): void {
    if (this.#drawnCount <= count && !this.#isTailDrawn) {
      return;
    }
    this.#drawnCount = Math.min(this.#drawnCount, count);
    this.#treesAsked = undefined;
    this.#isTailDrawn = false;
    this.#dropNextTail();
    this.#drawnTail.stop();
    this.#drawnTail = this.#holdTailParser();
  }

  /**
   * Draw what the cut settled as far as its trees allow, and answer the tail drawn after the drawn
   * blocks. Before the body's first draw nothing is on screen to keep, so the tail is the cut's
   * own, and every settled block is drawn with it once the body's definitions are read and every
   * tree the worker parses and the tail's have landed against them; after it, the waiting blocks
   * move out of the tail only together, once their trees and the shorter tail's have landed.
   */
  #drawWhatLanded(
    mode: ParseMode,
    definitions: DefinitionsView,
    areDefinitionsRead: boolean,
    tail: string,
  ): string {
    const generation = this.#generation;
    const count = generation.records.count;
    if (!this.#isTailDrawn) {
      const tailView = this.#drawnTail.parser.read();
      if (
        areDefinitionsRead &&
        this.#haveBlockTreesLanded(mode, definitions) &&
        (tail === "" ||
          (tailView?.status === "parsed" &&
            tailView.definitionPreamble === definitions.tailPreamble))
      ) {
        this.#drawnCount = count;
        this.#isTailDrawn = true;
        this.#replaced?.generation.letGo();
        this.#replaced = undefined;
      }
    } else if (
      this.#drawnCount < count &&
      areDefinitionsRead &&
      this.#haveWaitingBlocksLanded(mode, definitions, tail)
    ) {
      this.#drawnCount = count;
      this.#drawnTail.stop();
      this.#drawnTail = this.#nextTail ?? this.#holdTailParser();
      this.#nextTail = undefined;
    }
    return this.#drawnCount === count || !this.#isTailDrawn
      ? tail
      : generation.tailFrom(generation.records.startOf(this.#drawnCount));
  }

  /** Whether every block not yet drawn that the worker parses has its tree against its preamble. */
  #haveBlockTreesLanded(mode: ParseMode, definitions: DefinitionsView): boolean {
    const generation = this.#generation;
    for (let index = this.#drawnCount; index < generation.records.count; index += 1) {
      if (
        this.#needsWorker(generation, index, mode) &&
        generation.workerTrees.get(index)?.landedPreamble !== definitions.preambleOf(index)
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether every waiting block's tree has landed against its preamble, and the shorter tail's
   * tree reaches at least as far into the text as the drawn tail's: measured from the text's end,
   * it leaves no more characters undrawn.
   */
  #haveWaitingBlocksLanded(mode: ParseMode, definitions: DefinitionsView, tail: string): boolean {
    if (!this.#haveBlockTreesLanded(mode, definitions)) {
      return false;
    }
    if (tail === "") {
      return true;
    }
    const next = this.#nextTail?.parser.read();
    const drawn = this.#drawnTail.parser.read();
    if (next?.status !== "parsed" || drawn?.status !== "parsed") {
      return false;
    }
    const generation = this.#generation;
    const drawnTail = generation.tailFrom(generation.records.startOf(this.#drawnCount));
    return (
      tail.startsWith(next.tailSource) &&
      drawnTail.startsWith(drawn.tailSource) &&
      tail.length - next.tailSource.length <= drawnTail.length - drawn.tailSource.length
    );
  }

  /** Whether the worker parses block `index`: one too long for the page, or every one in `worker`. */
  #needsWorker(generation: BlockGeneration, index: number, mode: ParseMode): boolean {
    return mode === "worker" || generation.isOverPageCap(index);
  }

  /** Reads each block not yet read for its definitions that the page parses, or the cache keeps. */
  #readDefinitionsNow(mode: ParseMode): void {
    const generation = this.#generation;
    for (const index of [...generation.definitions.unread]) {
      const source = generation.readBlockSource(index);
      const tree =
        mode === "page" && !generation.isOverPageCap(index)
          ? this.#trees.parseSettledBlockNow(source, "")
          : this.#trees.readSettledBlock(source, "");
      if (tree !== undefined) {
        generation.definitions.read(index, tree.root);
      }
    }
  }

  /** The tail's definitions from the tree its parser shows, read again only when that changes. */
  #readTailDefinitions(): TailDefinitions {
    const view = this.#tailDefinitionParser.read();
    if (view?.status === "failed") {
      throw new Error(view.reason);
    }
    if (view === undefined) {
      return NO_TAIL_DEFINITIONS;
    }
    if (view.root !== this.#tailDefinitions.root) {
      this.#tailDefinitions = {
        root: view.root,
        read: definitionsOf(view.root),
        footnotes: collectFootnoteDefinitions(view.root.children).definitions,
      };
    }
    return this.#tailDefinitions;
  }

  /**
   * Takes the tree the shared trees keep of each block not drawn that the worker parses and not
   * yet asked for against its preamble; `requestReads` asks for it, and holds it, as for any other.
   */
  #readKeptBlockTrees(mode: ParseMode, definitions: DefinitionsView): void {
    const generation = this.#generation;
    for (let index = this.#drawnCount; index < generation.records.count; index += 1) {
      if (!this.#needsWorker(generation, index, mode)) {
        continue;
      }
      const preamble = definitions.preambleOf(index);
      const held = generation.workerTrees.get(index);
      if (held?.askedPreamble === preamble || held?.landedPreamble === preamble) {
        continue;
      }
      const kept = this.#trees.readSettledBlock(generation.readBlockSource(index), preamble);
      if (kept === undefined) {
        continue;
      }
      if (held === undefined) {
        generation.workerTrees.set(index, {
          askedPreamble: undefined,
          landedPreamble: preamble,
          tree: kept,
          stop: NO_STOP,
          letLandedGo: NO_STOP,
        });
      } else {
        held.tree = kept;
        held.landedPreamble = preamble;
      }
    }
  }

  /**
   * Asks for each tree the worker parses not yet asked for against its preamble, from where the
   * last ask stopped, so a frame costs the blocks settled since; and for a slice at most once one
   * is waiting: the tree that lands asks for the next slice, so a long reply read back asks for its
   * trees across tasks.
   */
  #requestWorkerTrees(
    generation: BlockGeneration,
    mode: ParseMode,
    definitions: DefinitionsView,
  ): void {
    const asked = this.#treesAsked;
    let askedCount =
      asked?.generation === generation && asked.view === definitions && asked.mode === mode
        ? asked.count
        : 0;
    const hasTime = startSlice();
    let isWaiting = false;
    for (; askedCount < generation.records.count; askedCount += 1) {
      if (isWaiting && !hasTime()) {
        break;
      }
      if (!this.#needsWorker(generation, askedCount, mode)) {
        continue;
      }
      const preamble = definitions.preambleOf(askedCount);
      if (generation.workerTrees.get(askedCount)?.askedPreamble !== preamble) {
        isWaiting = this.#requestBlockTree(generation, askedCount, preamble) || isWaiting;
      }
    }
    this.#treesAsked = { generation, view: definitions, mode, count: askedCount };
  }

  /** Asks for block `index`'s tree against `preamble`; answers whether the ask is waiting. */
  #requestBlockTree(generation: BlockGeneration, index: number, preamble: string): boolean {
    const held: HeldBlockTree = generation.workerTrees.get(index) ?? {
      askedPreamble: preamble,
      landedPreamble: undefined,
      tree: undefined,
      stop: NO_STOP,
      letLandedGo: NO_STOP,
    };
    held.stop();
    held.stop = NO_STOP;
    held.askedPreamble = preamble;
    generation.workerTrees.set(index, held);
    let answeredAtOnce: MarkdownParseOutcome | undefined;
    let isAsking = true;
    const letGo = this.#trees.holdSettledBlock(
      generation.readBlockSource(index),
      preamble,
      (outcome) => {
        if (isAsking) {
          answeredAtOnce = outcome;
          return;
        }
        this.#landBlockTree(held, preamble, outcome, letGo);
      },
    );
    isAsking = false;
    // A kept tree, or a stand-in parser's, is answered before the ask returns.
    if (answeredAtOnce === undefined) {
      held.stop = letGo;
      return true;
    }
    this.#landBlockTree(held, preamble, answeredAtOnce, letGo);
    return false;
  }

  /** Takes a block's landed tree, held in the shared trees in place of its last one. */
  #landBlockTree(
    held: HeldBlockTree,
    preamble: string,
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
    if (held.tree === outcome && held.landedPreamble === preamble) {
      return;
    }
    held.tree = outcome;
    held.landedPreamble = preamble;
    this.#changed();
  }

  /** Asks the worker for block `index`'s tree alone, for what it defines. */
  #requestDefinitions(generation: BlockGeneration, index: number): void {
    let answeredAtOnce: MarkdownParseOutcome | undefined;
    let isAsking = true;
    const stop = this.#trees.requestSettledBlock(
      generation.readBlockSource(index),
      "",
      (outcome) => {
        if (isAsking) {
          answeredAtOnce = outcome;
          return;
        }
        this.#landDefinitions(generation, index, outcome);
      },
    );
    isAsking = false;
    generation.definitionReads.set(index, stop);
    // A kept tree, or a stand-in parser's, is answered before the ask returns.
    if (answeredAtOnce !== undefined) {
      this.#landDefinitions(generation, index, answeredAtOnce);
    }
  }

  #landDefinitions(
    generation: BlockGeneration,
    index: number,
    outcome: MarkdownParseOutcome,
  ): void {
    generation.definitionReads.delete(index);
    if (outcome.status === "failed") {
      this.#failure = outcome.reason;
    } else {
      generation.definitions.read(index, outcome.root);
    }
    this.#changed();
  }

  /** Asks the worker to cut the text past the blocks cut so far, as whole when `isComplete`. */
  #requestCut(generation: BlockGeneration, text: PublishedText, isComplete: boolean): void {
    const from = generation.cutEnd;
    const source = text.slice(from);
    let isAsking = true;
    let isLanded = false;
    const stop = this.#trees.requestCut(source, isComplete, (answer) => {
      isLanded = true;
      generation.cutInFlight = undefined;
      if (answer.status === "failed") {
        this.#failure = answer.reason;
      } else if (generation.cutEnd === from) {
        generation.appendBlocks(
          Array.from(answer.blockEnds, (end) => from + end),
          isComplete ? from + source.length : undefined,
        );
      }
      // A cut that lands while it is asked changes the snapshot the next read makes.
      if (!isAsking) {
        this.#changed();
      }
    });
    isAsking = false;
    if (isLanded) {
      this.#changed();
    } else {
      generation.cutInFlight = stop;
    }
  }

  /** The snapshot drawing `drawn`, with the body's definitions as they stand. */
  #snapshotOf(
    drawn: DrawnGeneration,
    definitions: DefinitionsView,
    tailDefinitions: TailDefinitions,
  ): MarkdownBodyBlocksSnapshot {
    const { generation, drawnCount } = drawn;
    return {
      generation: this.#generation.number,
      records: generation.records,
      settledCount: drawnCount,
      isDrawn: this.#isTailDrawn || this.#replaced !== undefined,
      definingBlocks: this.#definingDrawnOf(drawn.view.definingBlocks, drawnCount),
      volatileTail: drawn.volatileTail,
      tailNodes: drawn.tailNodes,
      volatileTailDefinitions: tailDefinitions.footnotes,
      definedFootnoteIdentifiers: definitions.definedFootnoteIdentifiers,
      definitionPreamble: definitions.commonPreamble,
      readBlockSource: (index) => generation.readBlockSource(index),
      readBlockTree: (index) => this.#treeOf(drawn, index, true),
      readTransientBlockTree: (index) => this.#treeOf(drawn, index, false),
      readDefinitionPreamble: (index) =>
        index < drawnCount ? this.#preambleOf(drawn, index) : (drawn.tailPreamble ?? ""),
      keepPageTreesOf: (mounted) => {
        generation.keepPageTreesOf(mounted);
      },
    };
  }

  /** The drawn blocks among `definingBlocks`, the same array until either changes. */
  #definingDrawnOf(definingBlocks: readonly number[], drawnCount: number): readonly number[] {
    const held = this.#definingDrawn;
    if (held.of !== definingBlocks || held.count !== drawnCount) {
      this.#definingDrawn = {
        of: definingBlocks,
        count: drawnCount,
        blocks: definingBlocks.filter((index) => index < drawnCount),
      };
    }
    return this.#definingDrawn.blocks;
  }

  /**
   * Drawn block `index`'s tree: parsed on the page against its preamble, kept while mounted when
   * `isKept`, or the worker's newest landed tree. Throws for a block with no tree to draw.
   */
  #treeOf(drawn: DrawnGeneration, index: number, isKept: boolean): ParsedMarkdown {
    const generation = drawn.generation;
    if (this.#isPageParsed(generation, index)) {
      const preamble = drawn.view.preambleOf(index);
      const kept = generation.pageTreeOf(index, preamble);
      if (kept !== undefined) {
        return kept;
      }
      const parsed = this.#trees.parseSettledBlockNow(generation.readBlockSource(index), preamble);
      if (parsed === undefined) {
        throw new Error(`The page could not parse the block at ${String(index)}`);
      }
      if (isKept) {
        generation.keepPageTree(index, preamble, parsed);
      }
      return parsed;
    }
    const tree = generation.workerTrees.get(index)?.tree;
    if (tree === undefined) {
      throw new Error(`The block at ${String(index)} was drawn before its tree landed`);
    }
    return tree;
  }

  /** The preamble drawn block `index`'s tree is parsed after, as `#treeOf` draws it. */
  #preambleOf(drawn: DrawnGeneration, index: number): string {
    const generation = drawn.generation;
    if (this.#isPageParsed(generation, index)) {
      return drawn.view.preambleOf(index);
    }
    const preamble = generation.workerTrees.get(index)?.landedPreamble;
    if (preamble === undefined) {
      throw new Error(`The block at ${String(index)} was drawn before its tree landed`);
    }
    return preamble;
  }

  /** Whether the page parses block `index` now. */
  #isPageParsed(generation: BlockGeneration, index: number): boolean {
    return this.#trees.pageParser.state === "ready" && !generation.isOverPageCap(index);
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

  #changed(): void {
    this.#revision += 1;
    this.#changes.emit();
  }
}

/**
 * How a body's blocks are parsed: on the page; by the worker, every one, while the page's parser
 * could not start; or not yet, while the page's parser loads.
 */
type ParseMode = "page" | "worker" | "waiting";

/**
 * Where a body's cut stands: waiting on the worker's cut; streaming, its tail cut from the tail's
 * parses; or whole, every block cut.
 */
type CutState = "cutting" | "streaming" | "whole";

/** What one generation draws. */
interface DrawnGeneration {
  readonly generation: BlockGeneration;
  /** The definitions its blocks are drawn with. */
  readonly view: DefinitionsView;
  readonly drawnCount: number;
  readonly volatileTail: string;
  readonly tailNodes: readonly RootContent[] | undefined;
  /** The definitions the tail's drawn tree was parsed after. */
  readonly tailPreamble: string | undefined;
}

/** What the last read read, and the snapshot it made. */
interface LastRead {
  readonly text: PublishedText;
  readonly textRevision: number;
  readonly isComplete: boolean;
  readonly revision: number;
  readonly snapshot: MarkdownBodyBlocksSnapshot;
  /** What the current generation draws, which a replaced one keeps on screen. */
  readonly current: DrawnGeneration;
  readonly mode: ParseMode;
  readonly cutState: CutState;
  /** The text past the blocks cut, which the tail parses. */
  readonly tail: string;
  readonly areDefinitionsRead: boolean;
}

/** How far the worker's trees were asked for, and against what. */
interface TreesAsked {
  readonly generation: BlockGeneration;
  readonly view: DefinitionsView;
  readonly mode: ParseMode;
  readonly count: number;
}

/** A tail parser this body holds, and the stop that lets it go. */
interface HeldTailParser {
  readonly parser: VolatileTailParser;
  readonly stop: Unsubscribe;
}

/** The tail's tree its definitions were read from, and what it defines. */
interface TailDefinitions {
  readonly root: Root | undefined;
  readonly read: ReadDefinitions;
  readonly footnotes: readonly FootnoteDefinition[];
}

/** The drawn blocks among a list of defining ones, and what they were cut from. */
interface DefiningDrawn {
  readonly of: readonly number[];
  readonly count: number;
  readonly blocks: readonly number[];
}

const NO_TAIL_DEFINITIONS: TailDefinitions = Object.freeze({
  root: undefined,
  read: NO_DEFINITIONS,
  footnotes: Object.freeze([]),
});
