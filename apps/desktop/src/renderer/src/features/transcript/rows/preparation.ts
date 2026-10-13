// What a row's first frame waits on: in a message row, its body's blocks, cut by the parser,
// recorded in turn with the feed's other parses, the rows nearest the view first, and read as its
// body reads them, through the one reader the row publishes to its body, until the body can draw;
// then what its drawn blocks wait on (`DrawnBlockWaits`); in a reply or a tool's result drawn as
// command output or plain text, its parse into lines, read in slices while the row is within the
// drawn band's reach and, for a call, open. A reply's text is stripped of escapes here, once, and
// handed to its body to draw. The feed lists a row that arrives (a page read, a jump, a row read
// back) only once these have landed, and keeps every row it holds ready to scroll to by reading
// each one's text again as it grows. A row's text is read as its body reads it: a person's message,
// finished; a reply's live text, whose tail is still streaming and shows its source until it
// settles, or a tool's; and, with no lane, or once its lane retires, the stored body, finished. A
// typesetter, diagram or table failure counts as landed: the body draws its error state.

import { appMarkdownTrees } from "#renderer/components/Markdown/parse/trees.js";
import { publishedTextOf, type PublishedText } from "#renderer/lib/text/published.js";
import { readWireString } from "#renderer/lib/wire/strings.js";
import type { ProjectedTranscriptRow } from "#renderer/store/session/entities/vocabulary.js";
import { projectedPayload } from "#renderer/store/session/events/wire-payload.js";
import { StrippedText } from "./ansi/escape-sequences.js";
import { AnsiOutputPreparation, type OutputReach } from "./ansi/preparation.js";
import { outputKindOf } from "./bodies/output-kinds.js";
import { DrawnBlockWaits } from "./drawn-block-waits.js";
import { type RowParse } from "./prepared-bodies.js";
import { classifyTranscriptRow, isFoldableCall } from "./kind.js";
import { userMessageTextOf } from "./user-message.js";
import { MarkdownBodyBlocks } from "./markdown/body-blocks/reader.js";
import { type MarkdownBodyBlocksSnapshot } from "./markdown/body-blocks/snapshot.js";
import {
  type TranscriptRowPreparation,
  type TranscriptRowPreparer,
  type TranscriptRowSources,
} from "./renderer.js";

/**
 * Starts what a transcript row's first frame waits on: a message row's body, its finished formulas
 * and diagrams, and a reply's or a tool's output, read now and again on each `refresh`.
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
 * One message row's preparation. It owns the row's block reader, which its body reads too, so a
 * refresh reads only what changed since the last one, and asks for each formula and diagram once.
 */
class MessageRowPreparation implements TranscriptRowPreparation {
  readonly #row: ProjectedTranscriptRow;
  readonly #sources: TranscriptRowSources;
  readonly #onReady: () => void;
  readonly #blocks = new MarkdownBodyBlocks(appMarkdownTrees);
  /** Records the blocks of the body's landed cut a slice at a time, leaving its turn once done. */
  readonly #cutRecording: RowParse = {
    readInTurn: (hasTime) => {
      if (!this.#blocks.recordCut(hasTime)) {
        return false;
      }
      this.#sources.preparedBodies.leaveTurn(this.#cutRecording);
      return true;
    },
  };
  readonly #strippedText = new StrippedText();
  /** The reply's body parsed into lines, while it is drawn as command output or plain text. */
  readonly #output: AnsiOutputPreparation;
  readonly #drawnBlockWaits: DrawnBlockWaits;
  /** The reply's text last read as an output, or `undefined` while its body draws none. */
  #outputText: PublishedText | undefined;
  /** The body last read, its text's revision then, and the reader's. */
  #readBody: ReadBody | undefined;
  /**
   * The settled body last read and its source, a person's message or a stored body's holder, so a
   * refresh over the same source reads nothing.
   */
  #settledBody:
    | { readonly source: string | PublishedText; readonly body: MarkdownBody | undefined }
    | undefined;
  /** Lands the row's wait for its body to draw, while it waits. */
  #bodyDrawn: (() => void) | undefined;
  /** Whether the block reader changed while the row was read, so it is read once more. */
  #isReading = false;
  #hasChangedWhileReading = false;
  /** Whether a read is queued for the block reader's changes since the last one. */
  #isRefreshQueued = false;
  /** What stops the row hearing its block reader, and closes it. */
  readonly #withdrawals: (() => void)[] = [];
  #pendingCount = 0;
  #isReleased = false;

  public constructor(
    row: ProjectedTranscriptRow,
    sources: TranscriptRowSources,
    onReady: () => void,
  ) {
    this.#row = row;
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
    this.#drawnBlockWaits = new DrawnBlockWaits(
      row.id,
      sources,
      () => this.#startWaiting(),
      () => this.#readCurrentBlocks(),
    );
    this.#withdrawals.push(
      this.#blocks.subscribe(() => {
        if (this.#isReading) {
          this.#hasChangedWhileReading = true;
          return;
        }
        // Read once after every tree one answer of the parser lands, not once a tree: a reply of
        // thousands of blocks lands its trees together.
        if (!this.#isRefreshQueued) {
          this.#isRefreshQueued = true;
          queueMicrotask(() => {
            this.#isRefreshQueued = false;
            if (!this.#isReleased) {
              this.refresh();
            }
          });
        }
      }),
      () => {
        this.#blocks.close();
      },
    );
  }

  public get isReady(): boolean {
    return this.#pendingCount === 0 && this.#output.isReady;
  }

  public get isParsed(): boolean {
    // A body still waiting on its cut, the cut's recording or a tree would mount blank.
    return this.#output.isReady && this.#bodyDrawn === undefined && this.#drawnBlockWaits.isRead;
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
    const reach = this.#sources.reachOf(this.#row.id);
    this.#recordCutInTurn(reach);
    this.#output.read(this.#outputText, reach);
    this.#drawnBlockWaits.readOn(reach);
    this.#drawnBlockWaits.askForDiagrams();
  }

  public release(): void {
    this.#isReleased = true;
    this.#sources.preparedBodies.leaveTurn(this.#cutRecording);
    this.#output.release();
    this.#sources.preparedBodies.withdrawMarkdownBody(this.#row.id, this);
    for (const withdraw of this.#withdrawals) {
      withdraw();
    }
    this.#drawnBlockWaits.release();
  }

  /**
   * Reads the row's body as its body reads it, through the reader both share, and what its drawn
   * blocks wait on. The row waits until the body can draw. Then asks for the cut and the parses
   * the reader waits on.
   */
  #readNewBlocks(): void {
    const body = this.#readMarkdownBody();
    this.#publishBody(body);
    if (body === undefined) {
      this.#drawnBlockWaits.read(undefined);
      return;
    }
    const last = this.#readBody;
    if (
      body.text === last?.text &&
      body.text.revision === last.revision &&
      body.isComplete === last.isComplete &&
      this.#blocks.readRevision() === last.blocksRevision
    ) {
      return;
    }
    this.#readBody = {
      text: body.text,
      revision: body.text.revision,
      isComplete: body.isComplete,
      blocksRevision: this.#blocks.readRevision(),
    };
    let blocks: MarkdownBodyBlocksSnapshot;
    try {
      blocks = this.#blocks.read(body.text, body.isComplete);
    } catch {
      // A parse or a cut the body needs failed: the body throws it for its row's error boundary,
      // and the row waits on nothing more to draw that.
      this.#drawnBlockWaits.read(undefined);
      this.#landBodyDrawn();
      return;
    }
    this.#drawnBlockWaits.startLoadsForOpenFences(
      blocks.generation,
      body.text.length,
      blocks.volatileTail,
    );
    if (!blocks.isDrawn) {
      this.#bodyDrawn ??= this.#startWaiting();
    }
    this.#drawnBlockWaits.read(blocks);
    if (blocks.isDrawn) {
      this.#landBodyDrawn();
    }
    this.#blocks.requestReads();
  }

  /**
   * Puts the recording of the body's landed cut in turn while it waits: ahead of every parse while
   * the row is within the drawn band's reach, and keeping its place while it is outside.
   */
  #recordCutInTurn(reach: OutputReach): void {
    const preparedBodies = this.#sources.preparedBodies;
    if (
      this.#blocks.isRecordingCut &&
      (reach !== "outside" || !preparedBodies.isInTurn(this.#cutRecording))
    ) {
      preparedBodies.parseInTurn(this.#cutRecording, this.#sources.ownerWindow);
    }
  }

  /** The body's blocks as its body reads them now, for a later task; throws as the reader does. */
  #readCurrentBlocks(): MarkdownBodyBlocksSnapshot | undefined {
    const body = this.#readBody;
    return body === undefined ? undefined : this.#blocks.read(body.text, body.isComplete);
  }

  #landBodyDrawn(): void {
    const landed = this.#bodyDrawn;
    this.#bodyDrawn = undefined;
    landed?.();
  }

  /** The markdown the row's body draws now, or `undefined` while it draws none. */
  #readMarkdownBody(): MarkdownBody | undefined {
    if (classifyTranscriptRow(this.#row)?.kind === "user-message") {
      const message = userMessageTextOf(this.#row);
      return message === undefined
        ? undefined
        : this.#settledBodyOf(message, () => publishedTextOf(message));
    }
    const liveText = this.#sources.publishedTextFor(this.#row.id);
    if (liveText !== undefined) {
      const text = this.#proseOf(liveText, false);
      return text === undefined ? undefined : { text, isComplete: false };
    }
    // Once the lane retires the stored body takes over; it extends the lane's text, so the blocks
    // cut from that are kept.
    const content = this.#row.content;
    if (content?.status !== "available") {
      this.#outputText = undefined;
      return undefined;
    }
    return this.#settledBodyOf(content.body, () => this.#proseOf(content.body, true));
  }

  /**
   * A reply's text as its body draws it as markdown, or `undefined` for any other kind; a text
   * drawn as an output is kept for its output box's parse. Command output keeps its escapes, which
   * the parse reads its styling from; the other kinds are drawn stripped. `isSettled` says the text
   * never changes again.
   */
  #proseOf(text: PublishedText, isSettled: boolean): PublishedText | undefined {
    const contentType = readWireString(projectedPayload(this.#row)["contentType"]);
    const kind = outputKindOf(text, contentType);
    const drawnText = kind === "command-output" ? text : this.#strippedText.read(text, isSettled);
    this.#outputText = kind === "prose" ? undefined : drawnText;
    return kind === "prose" ? drawnText : undefined;
  }

  /** Hands the row's body the markdown it draws and the reader it reads it with, or drops it. */
  #publishBody(body: MarkdownBody | undefined): void {
    const rowId = this.#row.id;
    if (body === undefined) {
      this.#sources.preparedBodies.withdrawMarkdownBody(rowId, this);
    } else {
      this.#sources.preparedBodies.publishMarkdownBody(rowId, this, {
        text: body.text,
        isComplete: body.isComplete,
        blocks: this.#blocks,
      });
    }
  }

  /** The finished body read from `source`, read once per message string or stored holder. */
  #settledBodyOf(
    source: string | PublishedText,
    readText: () => PublishedText | undefined,
  ): MarkdownBody | undefined {
    if (this.#settledBody?.source !== source) {
      const text = readText();
      this.#settledBody = {
        source,
        body: text === undefined ? undefined : { text, isComplete: true },
      };
    }
    return this.#settledBody.body;
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
  readonly #row: ProjectedTranscriptRow;
  readonly #sources: TranscriptRowSources;
  readonly #output: AnsiOutputPreparation;

  public constructor(
    row: ProjectedTranscriptRow,
    sources: TranscriptRowSources,
    onReady: () => void,
  ) {
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

  public get isParsed(): boolean {
    return this.#output.isReady;
  }

  public refresh(): void {
    const rowId = this.#row.id;
    const liveText = this.#sources.publishedTextFor(rowId);
    // A folded call draws no output, so it waits on no parse until it opens.
    const isFolded =
      this.#sources.isCallFolded(rowId) && isFoldableCall(this.#row, liveText !== undefined);
    const content = this.#row.content;
    this.#output.read(
      isFolded
        ? undefined
        : (liveText ?? (content?.status === "available" ? content.body : undefined)),
      this.#sources.reachOf(rowId),
    );
  }

  public release(): void {
    this.#output.release();
  }
}

/** The markdown a row's body draws, and whether it is finished. */
interface MarkdownBody {
  readonly text: PublishedText;
  readonly isComplete: boolean;
}

/** The body a message row last read, and the reader's revision then. */
interface ReadBody {
  readonly text: PublishedText;
  readonly revision: number;
  readonly isComplete: boolean;
  readonly blocksRevision: number;
}
