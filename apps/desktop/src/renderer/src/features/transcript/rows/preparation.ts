// What a row's first frame waits on: in a message row, its body's reading, drawn whole, which holds
// the tree of each settled block, of the footnotes each defines and of the streaming tail in the
// app's shared trees, so the body mounted next draws them formatted from its first frame, the
// formula typesetter, once the row holds a finished formula, the picture of each finished diagram,
// and each long table's geometry; in a reply or a tool's result drawn as command output or plain
// text, its parse into lines, read in slices while the row is within the drawn band's reach and,
// for a call, open. A reply's text is stripped of escapes here, once, and handed to its body to
// draw. The feed lists a row that arrives (a page read, a jump, a row read back) only once these
// have landed, and keeps every row it holds ready to scroll to by reading each one's text again as
// it grows. A row's text is read as its body reads it: a person's message, finished; a reply's live
// text, whose tail is still streaming and shows its source until it settles, or a tool's; and, with
// no lane, or once its lane retires, the stored body, finished. A typesetter, diagram or table
// failure counts as landed: the body draws its error state. A formula or diagram fence still
// streaming starts the typesetter's load or the diagram worker as soon as it names its language,
// without the row waiting on either.

import type { Nodes, RootContent } from "mdast";

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
import { isReadInPieces } from "#renderer/components/Markdown/parse/pieced-table.js";
import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import {
  DEFERRED_FENCE_KINDS,
  readDeferredFenceKind,
  type DeferredFenceKind,
} from "#renderer/components/Markdown/rules.js";
import { typesetterLoadFor } from "#renderer/components/Markdown/typesetter/load.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import { publishedTextOf, type PublishedText } from "../reveal/published-text.js";
import { StrippedText } from "./ansi/escape-sequences.js";
import { AnsiOutputPreparation, type OutputReach } from "./ansi/preparation.js";
import { outputKindOf } from "./bodies/output-kinds.js";
import { classifyTranscriptRow, isFoldableCall } from "./kind.js";
import { userMessageTextOf } from "./user-message.js";
import { MarkdownBodyBlocks, type MarkdownBodyBlocksSnapshot } from "./markdown/body-blocks.js";
import { MarkdownBlockSegmenter } from "./markdown/parse/block-segmenter.js";
import { type SettledMarkdownBlock } from "./markdown/settled-block.js";
import { prepareTableWindows, type PreparedBlock } from "./markdown/table-window/preparation.js";
import {
  type TranscriptRowPreparation,
  type TranscriptRowPreparer,
  type TranscriptRowSources,
} from "./renderer.js";

/**
 * Starts what a transcript row's first frame waits on: a message row's finished formulas and
 * diagrams, and a reply's or a tool's output, read now and again on each `refresh`.
 * `undefined` for a row that draws neither markdown nor a tool's result.
 */
export const prepareTranscriptRow: TranscriptRowPreparer = (row, sources, onReady) => {
  const rowKind = classifyTranscriptRow(row)?.kind;
  let preparation: MessageRowPreparation | ToolRowPreparation;
  if (rowKind === "tool-call") {
    preparation = new ToolRowPreparation(row, sources, onReady);
  } else if (rowKind === "user-message" || rowKind === "agent-message") {
    preparation = new MessageRowPreparation(row, sources, onReady);
  } else {
    return undefined;
  }
  preparation.refresh();
  return preparation;
};

/**
 * One message row's preparation. It keeps the row's own segmenter and block reading, which holds
 * every tree the body draws while the row is held, so a refresh reads only what changed since the
 * last one, and asks for each formula and diagram once.
 */
class MessageRowPreparation implements TranscriptRowPreparation {
  readonly #row: TranscriptEventRow;
  readonly #sources: TranscriptRowSources;
  readonly #onReady: () => void;
  readonly #segmenter = new MarkdownBlockSegmenter();
  readonly #blocks = new MarkdownBodyBlocks(appMarkdownTrees);
  readonly #strippedText: StrippedText;
  /** The reply's body parsed into lines, while it is drawn as command output or plain text. */
  readonly #output: AnsiOutputPreparation;
  /** The reply's text last read as an output, or `undefined` while its body draws none. */
  #outputText: PublishedText | undefined;
  /** The text last read, and its revision then. */
  #readText: { readonly text: PublishedText; readonly revision: number } | undefined;
  /** The settled body last read and its source, so a refresh over the same string reads nothing. */
  #settledBody: { readonly source: string; readonly body: MarkdownBody | undefined } | undefined;
  /** The block reading's revision when it was last read. */
  #readBlocksRevision = -1;
  /** The drawn blocks and the revision their trees were last read at. */
  #readDrawnBlocks: readonly SettledMarkdownBlock[] = [];
  #readTreesRevision = -1;
  /** Each drawn block's tree read for its tables, formulas and diagrams, by the block's key. */
  readonly #readTrees = new Map<string, ReadBlockTree>();
  #readGeneration = -1;
  /** Lands the row's wait for its body to draw every settled block, while it waits. */
  #bodyDrawn: (() => void) | undefined;
  /** Whether the block reading changed while the row was read, so it is read once more. */
  #isReading = false;
  #hasChangedWhileReading = false;
  /** Where the streaming tail's lines have been read up to for a fence naming its language. */
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
    READING_DISTANCE_BY_REACH[this.#sources.reachOf(this.#row.id)];
  /** What stops the row hearing its block reading, and closes it. */
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
    this.#strippedText = new StrippedText(row.id);
    this.#sources = sources;
    this.#onReady = onReady;
    this.#output = new AnsiOutputPreparation(
      row.id,
      sources.preparedBodies,
      sources.ownerWindow,
      () => {
        if (this.#pendingCount === 0) {
          onReady();
        }
      },
    );
    this.#withdrawals.push(
      this.#blocks.subscribe(() => {
        if (this.#isReading) {
          this.#hasChangedWhileReading = true;
          return;
        }
        this.refresh();
      }),
      () => {
        this.#blocks.close();
      },
    );
  }

  public get isReady(): boolean {
    return this.#pendingCount === 0 && this.#output.isReady;
  }

  public get isOutputReady(): boolean {
    return this.#output.isReady;
  }

  public refresh(): void {
    // The parser can answer while it is asked, which reads the row again once this read is done.
    this.#isReading = true;
    try {
      do {
        this.#hasChangedWhileReading = false;
        this.#readNewBlocks();
      } while (this.#hasChangedWhileReading);
    } finally {
      this.#isReading = false;
    }
    this.#output.read(this.#outputText, this.#sources.reachOf(this.#row.id));
    this.#askForDiagrams();
  }

  public release(): void {
    this.#isReleased = true;
    this.#output.release();
    this.#sources.preparedBodies.withdrawMarkdownText(this.#row.id, this);
    for (const withdraw of this.#withdrawals) {
      withdraw();
    }
    for (const ask of this.#diagramAsks.values()) {
      ask.withdraw();
    }
    for (const read of this.#readTrees.values()) {
      read.releaseTables?.();
    }
    this.#letPicturesGo();
  }

  /**
   * Reads the row's body as the body reads it, with a block reading that holds each tree it draws
   * in the app's shared trees, so a body mounted next draws them at once, and reads each drawn
   * block's tree for what it waits on. The row waits until the body draws, every settled block on
   * its own or a tail covering the rest. Then asks for the parses the body's reading waits on.
   */
  #readNewBlocks(): void {
    const body = this.#readMarkdownBody();
    this.#publishReplyText(body?.text);
    if (
      body === undefined ||
      (body.text === this.#readText?.text &&
        body.text.revision === this.#readText.revision &&
        this.#blocks.readRevision() === this.#readBlocksRevision)
    ) {
      return;
    }
    this.#readText = { text: body.text, revision: body.text.revision };
    this.#readBlocksRevision = this.#blocks.readRevision();
    const segmentation = this.#segmenter.segment(body.text, { isFinal: body.isComplete });
    let blocks: MarkdownBodyBlocksSnapshot;
    try {
      blocks = this.#blocks.read(segmentation);
    } catch {
      // A parse the body needs failed: the body throws it for its row's error boundary, and the
      // row waits on nothing more to draw that.
      this.#landBodyDrawn();
      return;
    }
    if (blocks.generation !== this.#readGeneration) {
      this.#readGeneration = blocks.generation;
      this.#openFenceScanEnd = 0;
    }
    this.#startLoadsForOpenFences(body.text.length, blocks.volatileTail);
    // A drawn tail covers every block still moving out of it.
    const isBodyDrawn =
      blocks.volatileTail === ""
        ? blocks.settledBlocks.length === segmentation.settledBlocks.length
        : blocks.tailNodes !== undefined;
    if (!isBodyDrawn) {
      this.#bodyDrawn ??= this.#startWaiting();
    }
    this.#readDrawnTrees(blocks);
    if (isBodyDrawn) {
      this.#landBodyDrawn();
    }
    this.#blocks.requestReads();
  }

  /**
   * Reads each drawn block's tree not read before, a block's newer tree again, and lets go of
   * what the blocks no longer drawn started. Costs nothing on a frame that drew nothing new.
   */
  #readDrawnTrees(blocks: MarkdownBodyBlocksSnapshot): void {
    const drawnBlocks = blocks.settledBlocks;
    if (
      drawnBlocks === this.#readDrawnBlocks &&
      this.#readBlocksRevision === this.#readTreesRevision
    ) {
      return;
    }
    this.#readDrawnBlocks = drawnBlocks;
    this.#readTreesRevision = this.#readBlocksRevision;
    for (const [index, block] of drawnBlocks.entries()) {
      const nodes = blocks.readBlockNodes(block);
      const read = this.#readTrees.get(block.key);
      if (read?.nodes === nodes) {
        continue;
      }
      read?.releaseTables?.();
      this.#readTrees.set(block.key, {
        nodes,
        releaseTables: this.#readBlockTree({
          source: blocks.readBlockSource(block),
          fingerprint: block.fingerprint,
          definitionPreamble: blocks.readDefinitionPreamble(index),
          root: { type: "root", children: [...nodes] },
          definedFootnoteIdentifiers: blocks.definedFootnoteIdentifiers,
        }),
      });
    }
    if (this.#readTrees.size > drawnBlocks.length) {
      const drawnKeys = new Set(drawnBlocks.map((block) => block.key));
      for (const [key, read] of this.#readTrees) {
        if (!drawnKeys.has(key)) {
          read.releaseTables?.();
          this.#readTrees.delete(key);
        }
      }
    }
  }

  #landBodyDrawn(): void {
    const landed = this.#bodyDrawn;
    this.#bodyDrawn = undefined;
    landed?.();
  }

  /**
   * Starts what a drawn block's tree waits on: its long tables, formulas and diagrams. Answers
   * what releases the tables being measured, if the block holds a long one.
   */
  #readBlockTree(block: PreparedBlock): (() => void) | undefined {
    const releaseTables = this.#prepareTableWindows(block);
    if (!DEFERRED_FENCE_OPENER.test(block.source) && !block.source.includes("$")) {
      return releaseTables;
    }
    const fences: DeferredFence[] = [];
    collectDeferredFences(block.root, fences);
    // A table read in pieces is left unwalked, which would read every row; a dollar in its text
    // may open a formula in one of its cells.
    if (block.source.includes("$") && block.root.children.some(isReadInPieces)) {
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
    if (content?.status !== "available") {
      this.#outputText = undefined;
      return undefined;
    }
    return this.#settledBodyOf(content.body, (source) => this.#proseOf(publishedTextOf(source)));
  }

  /**
   * A reply's text as its body draws it as markdown, or `undefined` for any other kind; a text
   * drawn as an output is kept for its output box's parse. Command output keeps its escapes, which
   * the parse reads its styling from; the other kinds are drawn stripped.
   */
  #proseOf(text: PublishedText): PublishedText | undefined {
    const contentType = readWireString(projectedPayload(this.#row)["contentType"]);
    const kind = outputKindOf(text, contentType);
    const drawnText = kind === "command-output" ? text : this.#strippedText.read(text);
    this.#outputText = kind === "prose" ? undefined : drawnText;
    return kind === "prose" ? drawnText : undefined;
  }

  /** Hands a reply's body the markdown it draws, or drops it; a person's message reads its own. */
  #publishReplyText(text: PublishedText | undefined): void {
    const rowId = this.#row.id;
    if (classifyTranscriptRow(this.#row)?.kind !== "agent-message") {
      return;
    }
    if (text === undefined) {
      this.#sources.preparedBodies.withdrawMarkdownText(rowId, this);
    } else {
      this.#sources.preparedBodies.publishMarkdownText(rowId, this, text);
    }
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
   * or the text size changed) withdraws every ask made under the old one and asks for every
   * diagram again, since a picture is drawn in its palette; the row waits on the new asks alone.
   */
  #askForDiagrams(): void {
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
      if (this.#pendingCount === 0 && this.#output.isReady) {
        this.#onReady();
      }
    };
  }
}

/**
 * One tool row's preparation: its result parsed into lines while the call is open, read as its body
 * reads it, the lane's live text first and then the stored body. A result is never markdown and,
 * drawn as plain text, carries no escape, so it is parsed as it is.
 */
class ToolRowPreparation implements TranscriptRowPreparation {
  readonly #row: TranscriptEventRow;
  readonly #sources: TranscriptRowSources;
  readonly #output: AnsiOutputPreparation;
  /** The stored body last read and its handle, so a refresh over the same string reads nothing. */
  #storedOutput: { readonly source: string; readonly text: PublishedText } | undefined;

  public constructor(row: TranscriptEventRow, sources: TranscriptRowSources, onReady: () => void) {
    this.#row = row;
    this.#sources = sources;
    this.#output = new AnsiOutputPreparation(
      row.id,
      sources.preparedBodies,
      sources.ownerWindow,
      onReady,
    );
  }

  public get isReady(): boolean {
    return this.#output.isReady;
  }

  public get isOutputReady(): boolean {
    return this.#output.isReady;
  }

  public refresh(): void {
    const rowId = this.#row.id;
    const liveText = this.#sources.publishedTextFor(rowId);
    // A folded call draws no output, so it waits on no parse until it opens.
    const isFolded =
      this.#sources.isCallFolded(rowId) && isFoldableCall(this.#row, liveText !== undefined);
    this.#output.read(
      isFolded ? undefined : (liveText ?? this.#readStoredOutput()),
      this.#sources.reachOf(rowId),
    );
  }

  public release(): void {
    this.#output.release();
  }

  /** The stored body's handle, or `undefined` while the row carries none to draw. */
  #readStoredOutput(): PublishedText | undefined {
    const content = this.#row.content;
    if (content?.status !== "available") {
      return undefined;
    }
    if (this.#storedOutput?.source !== content.body) {
      this.#storedOutput = { source: content.body, text: publishedTextOf(content.body) };
    }
    return this.#storedOutput.text;
  }
}

/** One drawn block's tree as the row read it, and what releases the tables it started measuring. */
interface ReadBlockTree {
  readonly nodes: readonly RootContent[];
  readonly releaseTables: (() => void) | undefined;
}

/** The markdown a row's body draws, and whether it is finished. */
interface MarkdownBody {
  readonly text: PublishedText;
  readonly isComplete: boolean;
}

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

/**
 * A fence that opens a formula or a diagram: what a block must hold, or else a dollar, before it is
 * parsed for one. Read loosely, so it may match a fence the parse then reads as code.
 */
const DEFERRED_FENCE_OPENER = new RegExp(
  `(?:\`{3,}|~{3,})[ \\t]*(${Object.keys(DEFERRED_FENCE_KINDS).join("|")})(?![^\\s])`,
  "iu",
);

/** Every such fence in a run of complete lines, each with its language. */
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
