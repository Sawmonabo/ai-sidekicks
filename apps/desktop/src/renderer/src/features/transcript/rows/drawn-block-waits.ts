// What a message row's drawn blocks wait on before the row is listed: each long table's geometry,
// the formula typesetter once a block holds a finished formula, and the picture of each finished
// diagram. Only a block whose text could hold one is read, its tree read once per text and
// preamble and let go at once, so the window's own sweep of its trees never makes the row parse a
// block again. A formula or diagram fence still streaming starts the typesetter's load or the
// diagram worker as soon as it names its language, without the row waiting on either.

import type { Nodes } from "mdast";

import {
  type DiagramPictures,
  type PictureShowing,
  type ReadingDistance,
} from "#renderer/components/Markdown/diagram/pictures.js";
import { type DiagramOutcome } from "#renderer/components/Markdown/diagram/worker/messages.js";
import {
  watchDiagramPalette,
  type DiagramPalette,
} from "#renderer/components/Markdown/diagram/palette.js";
import { isReadInPieces } from "#renderer/components/Markdown/parse/pieced-table.js";
import {
  readDeferredFenceKind,
  type DeferredFenceKind,
} from "#renderer/components/Markdown/rules.js";
import { typesetterLoadFor } from "#renderer/components/Markdown/typesetter/load.js";
import { type OutputReach } from "./ansi/preparation.js";
import { BlockFlag, type BlockRecords } from "./markdown/block-records.js";
import { type MarkdownBodyBlocksSnapshot } from "./markdown/body-blocks/snapshot.js";
import { DEFERRED_FENCE_OPENER } from "./markdown/settled-block.js";
import { prepareTableWindows, type PreparedBlock } from "./markdown/table-window/preparation.js";
import { type TranscriptRowSources } from "./renderer.js";

/**
 * Starts and holds what one message row's drawn blocks wait on. `startWaiting` counts one more
 * piece of work the row waits on and answers what lands it.
 */
export class DrawnBlockWaits {
  readonly #rowId: string;
  readonly #sources: TranscriptRowSources;
  readonly #startWaiting: () => () => void;
  /** Each drawn block read for what it waits on, by its index. */
  readonly #reads = new Map<number, DrawnBlockRead>();
  /** The records, drawn count and preamble the blocks were last read at. */
  #readBlocks: ReadBlocks | undefined;
  /** The generation the open fences were last scanned in, and where its tail's lines were read up to. */
  #scannedGeneration = -1;
  #openFenceScanEnd = 0;
  #hasStartedTypesetter = false;
  #hasStartedDiagramWorker = false;
  #hasAskedForTypesetter = false;
  /** Every diagram the row holds, and each one asked for under the palette last read, by source. */
  readonly #diagramSources = new Set<string>();
  readonly #diagramAsks = new Map<string, DiagramAsk>();
  #askedPalette: DiagramPalette | undefined;
  /** How far the row stands from the reading position, read each time the queue chooses. */
  readonly #readingDistance: ReadingDistance = () =>
    READING_DISTANCE_BY_REACH[this.#sources.reachOf(this.#rowId)];
  /** The pictures loaded ahead of their blocks, each with the image that loaded it. */
  readonly #loadedPictures: {
    readonly showing: PictureShowing;
    readonly image: HTMLImageElement;
  }[] = [];
  #isReleased = false;

  public constructor(rowId: string, sources: TranscriptRowSources, startWaiting: () => () => void) {
    this.#rowId = rowId;
    this.#sources = sources;
    this.#startWaiting = startWaiting;
  }

  /**
   * Reads each drawn block whose text could hold a long table, a formula or a diagram and that was
   * not read at its text and preamble before, and lets go of what a block no longer drawn, or
   * since changed, started. While the blocks and their definitions stand, only the blocks drawn
   * since and the ones read before are looked at: a worker's tree can land against new
   * definitions after them.
   */
  public read(blocks: MarkdownBodyBlocksSnapshot): void {
    const { records, settledCount, definitionPreamble } = blocks;
    const last = this.#readBlocks;
    const isSameRead = last?.records === records && last.definitionPreamble === definitionPreamble;
    this.#readBlocks = { records, count: settledCount, definitionPreamble };
    for (const index of [...this.#reads.keys()]) {
      if (index >= settledCount) {
        this.#reads.get(index)?.releaseTables?.();
        this.#reads.delete(index);
      } else if (isSameRead && index < last.count) {
        this.#readBlock(blocks, records, index);
      }
    }
    const from = isSameRead ? Math.min(last.count, settledCount) : 0;
    for (let index = from; index < settledCount; index += 1) {
      this.#readBlock(blocks, records, index);
    }
  }

  /**
   * Starts the typesetter's load or the diagram worker once a streaming fence names its language,
   * so either has loaded by the time the fence settles; the row still waits only on drawn blocks.
   * Each complete line of the tail is read once per generation. A fence nested in code may start
   * one needlessly.
   */
  public startLoadsForOpenFences(
    generation: number,
    textLength: number,
    volatileTail: string,
  ): void {
    if (generation !== this.#scannedGeneration) {
      this.#scannedGeneration = generation;
      this.#openFenceScanEnd = 0;
    }
    const pictures = this.#sources.diagramPictures;
    if (this.#hasStartedTypesetter && (this.#hasStartedDiagramWorker || pictures === undefined)) {
      return;
    }
    const tailStart = textLength - volatileTail.length;
    const scanStart = Math.max(0, this.#openFenceScanEnd - tailStart);
    const completeLinesEnd = volatileTail.lastIndexOf("\n") + 1;
    if (completeLinesEnd <= scanStart) {
      return;
    }
    this.#openFenceScanEnd = tailStart + completeLinesEnd;
    const lines = volatileTail.slice(scanStart, completeLinesEnd);
    for (const [, language] of lines.matchAll(OPEN_FENCE_LANGUAGES)) {
      if (readDeferredFenceKind(language) === "math") {
        if (!this.#hasStartedTypesetter) {
          this.#hasStartedTypesetter = true;
          // A refused chunk is asked for again by the settled formula, which draws its failure.
          void typesetterLoadFor(this.#sources.ownerWindow.document).load();
        }
      } else if (!this.#hasStartedDiagramWorker && pictures !== undefined) {
        this.#hasStartedDiagramWorker = true;
        pictures.startWorker();
      }
    }
  }

  /**
   * Asks for each diagram not yet asked for under the window's palette. A new palette (the theme
   * or the text size changed) withdraws every ask made under the old one and asks for every
   * diagram again, since a picture is drawn in its palette; the row waits on the new asks alone.
   */
  public askForDiagrams(): void {
    const pictures = this.#sources.diagramPictures;
    // Outside the app a diagram block refuses to draw at all, and says so itself.
    if (pictures === undefined || this.#diagramSources.size === 0) {
      return;
    }
    const palette = watchDiagramPalette(this.#sources.ownerWindow).read();
    const staleAsks = palette === this.#askedPalette ? [] : [...this.#diagramAsks.values()];
    if (palette !== this.#askedPalette) {
      this.#askedPalette = palette;
      this.#diagramAsks.clear();
      for (const ask of staleAsks) {
        ask.withdraw();
      }
      this.#letPicturesGo();
    }
    for (const source of this.#diagramSources) {
      if (this.#diagramAsks.has(source)) {
        continue;
      }
      const landed = this.#startWaiting();
      const kept = pictures.read(source, palette);
      if (kept === undefined) {
        this.#diagramAsks.set(source, {
          withdraw: pictures.request(source, palette, this.#readingDistance, (outcome) => {
            this.#loadPicture(pictures, outcome, landed);
          }),
          landed,
        });
      } else {
        this.#diagramAsks.set(source, { withdraw: NOTHING_TO_WITHDRAW, landed });
        this.#loadPicture(pictures, kept, landed);
      }
    }
    // Counted off once the new asks are counted, so the row is never ready in between.
    for (const ask of staleAsks) {
      ask.landed();
    }
  }

  /** Withdraws every ask and measuring still running, and lets go of the pictures loaded. */
  public release(): void {
    this.#isReleased = true;
    for (const ask of this.#diagramAsks.values()) {
      ask.withdraw();
    }
    for (const read of this.#reads.values()) {
      read.releaseTables?.();
    }
    this.#letPicturesGo();
  }

  /**
   * Reads drawn block `index` for what it waits on, if its text could hold any and it changed, or
   * its preamble did, since it was last read; lets go of what it started before.
   */
  #readBlock(blocks: MarkdownBodyBlocksSnapshot, records: BlockRecords, index: number): void {
    const read = this.#reads.get(index);
    if ((records.flagsAt(index) & WAITING_FLAGS) === 0) {
      if (read !== undefined) {
        read.releaseTables?.();
        this.#reads.delete(index);
      }
      return;
    }
    const hash = records.hashAt(index);
    const definitionPreamble = blocks.readDefinitionPreamble(index);
    if (read?.hash === hash && read.definitionPreamble === definitionPreamble) {
      return;
    }
    read?.releaseTables?.();
    const tree = blocks.readTransientBlockTree(index);
    this.#reads.set(index, {
      hash,
      definitionPreamble,
      releaseTables: this.#startWaitsOf(records, index, {
        source: blocks.readBlockSource(index),
        fingerprint: records.fingerprintAt(index),
        definitionPreamble,
        root: tree.root,
        definedFootnoteIdentifiers: blocks.definedFootnoteIdentifiers,
      }),
    });
  }

  /**
   * Starts what a drawn block's tree waits on: its long tables, formulas and diagrams. Answers
   * what releases the tables being measured, if the block holds a long one.
   */
  #startWaitsOf(
    records: BlockRecords,
    index: number,
    block: PreparedBlock,
  ): (() => void) | undefined {
    const releaseTables = this.#prepareTableWindows(block);
    const holdsDollar = records.hasFlag(index, BlockFlag.HoldsDollar);
    if (!records.hasFlag(index, BlockFlag.MayOpenDeferredFence) && !holdsDollar) {
      return releaseTables;
    }
    const fences: DeferredFence[] = [];
    collectDeferredFences(block.root, fences);
    // A table read in pieces is left unwalked, which would read every row; a dollar in its text
    // may open a formula in one of its cells.
    if (holdsDollar && block.root.children.some(isReadInPieces)) {
      this.#askForTypesetter();
    }
    for (const fence of fences) {
      if (fence.kind === "math") {
        this.#askForTypesetter();
      } else {
        this.#diagramSources.add(fence.source);
      }
    }
    return releaseTables;
  }

  /**
   * Measures the block's long tables off the list, so each draws its window on its first frame.
   * Answers what releases them, after which a table not yet measured is waited on no longer.
   */
  #prepareTableWindows(block: PreparedBlock): (() => void) | undefined {
    let landed: (() => void) | undefined;
    const preparation = prepareTableWindows(block, this.#sources.offListTables, () => {
      landed?.();
    });
    if (preparation === undefined) {
      return undefined;
    }
    // Its tables land in later observations and slices, never while it starts.
    if (!preparation.isReady) {
      landed = this.#startWaiting();
    }
    return () => {
      preparation.release();
      landed?.();
    };
  }

  #askForTypesetter(): void {
    if (this.#hasAskedForTypesetter) {
      return;
    }
    this.#hasAskedForTypesetter = true;
    const load = typesetterLoadFor(this.#sources.ownerWindow.document);
    if (load.loadedValue === undefined) {
      const landed = this.#startWaiting();
      // A refused chunk lands too: the formula draws its failure, which the chunk load records.
      void load.load().then(landed, landed);
    }
  }

  /**
   * Loads a drawn picture at the address its block will show it at, so the block's image is
   * complete on the frame it mounts; an image loads its address a frame later otherwise, and that
   * frame paints an empty box. The address is held while the window holds the row, which keeps
   * it among the document's loaded images. A refused drawing, or one that cannot load, lands as
   * it is: the block draws its failure.
   */
  #loadPicture(pictures: DiagramPictures, outcome: DiagramOutcome, landed: () => void): void {
    if (outcome.kind !== "drawn" || this.#isReleased) {
      landed();
      return;
    }
    const showing = pictures.showPicture(outcome);
    const image = this.#sources.ownerWindow.document.createElement("img");
    image.src = showing.url;
    this.#loadedPictures.push({ showing, image });
    void image.decode().then(landed, landed);
  }

  /** Lets go of every picture loaded ahead. */
  #letPicturesGo(): void {
    for (const loaded of this.#loadedPictures) {
      loaded.showing.release();
    }
    this.#loadedPictures.length = 0;
  }
}

/** One drawn block as the row read it: its text's hash, its preamble, and what releases its tables. */
interface DrawnBlockRead {
  readonly hash: number;
  readonly definitionPreamble: string;
  readonly releaseTables: (() => void) | undefined;
}

/** The blocks the row last read, and the preamble they were drawn with. */
interface ReadBlocks {
  readonly records: BlockRecords;
  readonly count: number;
  readonly definitionPreamble: string;
}

/** The flags of a block whose text could hold a long table, a formula or a diagram. */
const WAITING_FLAGS =
  BlockFlag.MayOpenDeferredFence | BlockFlag.HoldsDollar | BlockFlag.MayHoldLongTable;

/**
 * A fence or a formula that draws as a formula or a picture once its block has settled, and its
 * source.
 */
interface DeferredFence {
  readonly kind: DeferredFenceKind;
  readonly source: string;
}

function collectDeferredFences(node: Nodes, into: DeferredFence[]): void {
  if (isReadInPieces(node)) {
    return;
  }
  if (node.type === "math" || node.type === "inlineMath") {
    into.push({ kind: "math", source: node.value });
    return;
  }
  if (node.type === "code") {
    const kind = readDeferredFenceKind(node.lang);
    if (kind !== undefined) {
      into.push({ kind, source: node.value });
    }
    return;
  }
  if ("children" in node) {
    for (const child of node.children) {
      collectDeferredFences(child, into);
    }
  }
}

/** Every fence opening a formula or a diagram in a run of complete lines, each with its language. */
const OPEN_FENCE_LANGUAGES = new RegExp(DEFERRED_FENCE_OPENER.source, "giu");

/** One diagram a message row asked for: how to withdraw the ask, and how to count it landed. */
interface DiagramAsk {
  readonly withdraw: () => void;
  readonly landed: () => void;
}

const NOTHING_TO_WITHDRAW = (): void => undefined;

/**
 * How far a row stands from the reading position by how near the viewport it is, for the drawing
 * queue: a row in view at it, one in the drawn band after every mounted block's own distance in
 * pixels, and one outside the band last. A row not mounted has no distance in pixels to give.
 */
const READING_DISTANCE_BY_REACH: Readonly<Record<OutputReach, number>> = {
  view: 0,
  band: Number.MAX_VALUE,
  outside: Number.POSITIVE_INFINITY,
};
