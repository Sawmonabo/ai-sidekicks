// What a message row's first frame waits on: the formula typesetter, once the row holds a finished
// formula, the picture of each finished diagram, and each long table's geometry. The feed lists a
// row that arrives (a page read, a jump, a row read back) only once these have landed, and keeps
// every row it holds ready to scroll to by reading each one's text again as it grows. A row's text
// is read as its body reads it: a person's message, finished; a reply's live text, whose tail is
// still streaming and shows its source until it settles; and, with no lane, or once its lane
// retires, the reply's stored body, finished. A failure counts as landed: the body draws its error
// state. A formula or diagram fence still streaming starts the typesetter's load or the diagram
// worker as soon as it names its language, without the row waiting on either.

import type { Nodes } from "mdast";

import type { TranscriptEventRow } from "@ai-sidekicks/contracts/transcript/row";

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
import { parseSettledBlock } from "#renderer/components/Markdown/parse.js";
import {
  DEFERRED_FENCE_KINDS,
  readDeferredFenceKind,
  type DeferredFenceKind,
} from "#renderer/components/Markdown/rules.js";
import { typesetterLoadFor } from "#renderer/components/Markdown/typesetter/load.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import { publishedTextOf, type PublishedText } from "../reveal/published-text.js";
import { withoutResidualEscapesOf } from "./ansi/escape-sequences.js";
import { outputKindOf } from "./bodies/output-kinds.js";
import { classifyTranscriptRow } from "./kind.js";
import { userMessageTextOf } from "./user-message.js";
import { MarkdownBodyBlocks, type MarkdownBodyBlocksSnapshot } from "./markdown/body-blocks.js";
import { MarkdownBlockSegmenter } from "./markdown/parse/block-segmenter.js";
import { prepareTableWindows } from "./markdown/table-window/preparation.js";
import {
  type TranscriptRowPreparation,
  type TranscriptRowPreparer,
  type TranscriptRowSources,
} from "./renderer.js";

/**
 * Starts what a transcript row's first frame waits on: a message row's finished formulas and
 * diagrams, read now and again on each `refresh`. `undefined` for a row that draws no markdown.
 */
export const prepareTranscriptRow: TranscriptRowPreparer = (row, sources, onReady) => {
  const rowKind = classifyTranscriptRow(row)?.kind;
  if (rowKind !== "user-message" && rowKind !== "agent-message") {
    return undefined;
  }
  const preparation = new MessageRowPreparation(row, sources, onReady);
  preparation.refresh();
  return preparation;
};

/**
 * One message row's preparation. It keeps the row's own segmenter and block reading, so a refresh
 * reads only the blocks settled since the last one, and asks for each formula and diagram once.
 */
class MessageRowPreparation implements TranscriptRowPreparation {
  readonly #row: TranscriptEventRow;
  readonly #sources: TranscriptRowSources;
  readonly #onReady: () => void;
  readonly #segmenter = new MarkdownBlockSegmenter();
  readonly #blocks = new MarkdownBodyBlocks();
  /** The text last read, and its revision then. */
  #readText: { readonly text: PublishedText; readonly revision: number } | undefined;
  /** The settled body last read and its source, so a refresh over the same string reads nothing. */
  #settledBody: { readonly source: string; readonly body: MarkdownBody | undefined } | undefined;
  /** The settled blocks read so far, in the segmentation's generation. */
  #readBlockCount = 0;
  #readGeneration = -1;
  /** Where the streaming tail's lines have been read up to for a fence naming its language. */
  #openFenceScanEnd = 0;
  #hasStartedTypesetter = false;
  #hasStartedDiagramWorker = false;
  #hasAskedForTypesetter = false;
  /** Every diagram the row holds, and the ones asked for under the palette last read. */
  readonly #diagramSources = new Set<string>();
  readonly #askedDiagramSources = new Set<string>();
  #askedPalette: DiagramPalette | undefined;
  readonly #withdrawals: (() => void)[] = [];
  /** The pictures loaded ahead of their blocks, each with the image that loaded it. */
  readonly #loadedPictures: {
    readonly showing: PictureShowing;
    readonly image: HTMLImageElement;
  }[] = [];
  #pendingCount = 0;
  #isReleased = false;

  public constructor(row: TranscriptEventRow, sources: TranscriptRowSources, onReady: () => void) {
    this.#row = row;
    this.#sources = sources;
    this.#onReady = onReady;
  }

  public get isReady(): boolean {
    return this.#pendingCount === 0;
  }

  public refresh(): void {
    this.#readNewBlocks();
    this.#askForDiagrams();
  }

  public release(): void {
    this.#isReleased = true;
    for (const withdraw of this.#withdrawals) {
      withdraw();
    }
    this.#letPicturesGo();
  }

  /** Reads the blocks settled since the last read, for the formulas and diagrams they hold. */
  #readNewBlocks(): void {
    const body = this.#readMarkdownBody();
    if (
      body === undefined ||
      (body.text === this.#readText?.text && body.text.revision === this.#readText.revision)
    ) {
      return;
    }
    this.#readText = { text: body.text, revision: body.text.revision };
    const blocks = this.#blocks.read(
      this.#segmenter.segment(body.text, { isFinal: body.isComplete }),
    );
    if (blocks.generation !== this.#readGeneration) {
      this.#readGeneration = blocks.generation;
      this.#readBlockCount = 0;
      this.#openFenceScanEnd = 0;
    }
    this.#startLoadsForOpenFences(body.text.length, blocks.volatileTail);
    const settledBlocks = blocks.settledBlocks;
    for (const block of settledBlocks.slice(this.#readBlockCount)) {
      const blockSource = blocks.readBlockSource(block);
      this.#prepareTableWindows(blockSource, blocks);
      if (DEFERRED_FENCE_OPENER.test(blockSource)) {
        const fences: DeferredFence[] = [];
        collectDeferredFences(parseSettledBlock(blockSource, blocks.definitionPreamble), fences);
        for (const fence of fences) {
          if (fence.kind === "math") {
            this.#askForTypesetter();
          } else {
            this.#diagramSources.add(fence.source);
          }
        }
      }
    }
    // A body marked finished and then streaming again holds its last blocks back once more.
    this.#readBlockCount = settledBlocks.length;
  }

  /**
   * Starts the typesetter's load or the diagram worker once a streaming fence names its language,
   * so either has loaded by the time the fence settles; the row still waits only on settled blocks.
   * Each complete line of the tail is read once. A fence nested in code may start one needlessly.
   */
  #startLoadsForOpenFences(textLength: number, volatileTail: string): void {
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

  /** Measures the block's long tables off the list, so each draws its window on its first frame. */
  #prepareTableWindows(blockSource: string, blocks: MarkdownBodyBlocksSnapshot): void {
    let landed: (() => void) | undefined;
    const preparation = prepareTableWindows(
      {
        source: blockSource,
        definitionPreamble: blocks.definitionPreamble,
        definedFootnoteIdentifiers: blocks.definedFootnoteIdentifiers,
      },
      this.#sources.offListTables,
      () => {
        landed?.();
      },
    );
    if (preparation === undefined) {
      return;
    }
    this.#withdrawals.push(() => {
      preparation.release();
    });
    // Its tables land in later observations and slices, never while it starts.
    if (!preparation.isReady) {
      landed = this.#startWaiting();
    }
  }

  /** The markdown the row's body draws now, or `undefined` while it draws none. */
  #readMarkdownBody(): MarkdownBody | undefined {
    if (classifyTranscriptRow(this.#row)?.kind === "user-message") {
      const message = userMessageTextOf(this.#row);
      return message === undefined ? undefined : this.#settledBodyOf(message, publishedTextOf);
    }
    const liveText = this.#sources.publishedTextFor(this.#row.id);
    if (liveText !== undefined) {
      const text = this.#proseOf(liveText);
      return text === undefined ? undefined : { text, isComplete: false };
    }
    // Once the lane retires the stored body takes over; it extends the lane's text, so the blocks
    // read from that are kept.
    const content = this.#row.content;
    return content?.status === "available"
      ? this.#settledBodyOf(content.body, (source) => this.#proseOf(publishedTextOf(source)))
      : undefined;
  }

  /** A reply's text as its body draws it as markdown, or `undefined` for any other kind. */
  #proseOf(text: PublishedText): PublishedText | undefined {
    const contentType = readWireString(projectedPayload(this.#row)["contentType"]);
    return outputKindOf(text, contentType) === "prose" ? withoutResidualEscapesOf(text) : undefined;
  }

  /** The finished body read from `source`, read once per string. */
  #settledBodyOf(
    source: string,
    readText: (source: string) => PublishedText | undefined,
  ): MarkdownBody | undefined {
    if (this.#settledBody?.source !== source) {
      const text = readText(source);
      this.#settledBody = {
        source,
        body: text === undefined ? undefined : { text, isComplete: true },
      };
    }
    return this.#settledBody.body;
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
   * Asks for each diagram not yet asked for under the window's palette. A new palette (the theme
   * or the text size changed) asks for every one again, since a picture is drawn in its palette.
   */
  #askForDiagrams(): void {
    const pictures = this.#sources.diagramPictures;
    // Outside the app a diagram block refuses to draw at all, and says so itself.
    if (pictures === undefined || this.#diagramSources.size === 0) {
      return;
    }
    const palette = watchDiagramPalette(this.#sources.ownerWindow).read();
    if (palette !== this.#askedPalette) {
      this.#askedPalette = palette;
      this.#askedDiagramSources.clear();
      this.#letPicturesGo();
    }
    if (this.#askedDiagramSources.size === this.#diagramSources.size) {
      return;
    }
    for (const source of this.#diagramSources) {
      if (this.#askedDiagramSources.has(source)) {
        continue;
      }
      this.#askedDiagramSources.add(source);
      const landed = this.#startWaiting();
      const kept = pictures.read(source, palette);
      if (kept === undefined) {
        this.#withdrawals.push(
          pictures.request(source, palette, AT_READING_POSITION, (outcome) => {
            this.#loadPicture(pictures, outcome, landed);
          }),
        );
      } else {
        this.#loadPicture(pictures, kept, landed);
      }
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

  /** Counts one more piece of work, and returns what it calls once, when it lands. */
  #startWaiting(): () => void {
    this.#pendingCount += 1;
    let hasLanded = false;
    return () => {
      if (hasLanded || this.#isReleased) {
        return;
      }
      hasLanded = true;
      this.#pendingCount -= 1;
      if (this.#pendingCount === 0) {
        this.#onReady();
      }
    };
  }
}

/** The markdown a row's body draws, and whether it is finished. */
interface MarkdownBody {
  readonly text: PublishedText;
  readonly isComplete: boolean;
}

/** A fence that draws as a formula or a picture once its block has settled, and its source. */
interface DeferredFence {
  readonly kind: DeferredFenceKind;
  readonly source: string;
}

function collectDeferredFences(node: Nodes, into: DeferredFence[]): void {
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

/**
 * A fence that opens a formula or a diagram: what a block must hold before it is parsed for one.
 * Read loosely, so it may match a fence the parse then reads as code.
 */
const DEFERRED_FENCE_OPENER = new RegExp(
  `(?:\`{3,}|~{3,})[ \\t]*(${Object.keys(DEFERRED_FENCE_KINDS).join("|")})(?![^\\s])`,
  "iu",
);

/** Every such fence in a run of complete lines, each with its language. */
const OPEN_FENCE_LANGUAGES = new RegExp(DEFERRED_FENCE_OPENER.source, "giu");

/** A row the feed holds is what the reader is about to see, so its pictures go first. */
const AT_READING_POSITION: ReadingDistance = () => 0;
