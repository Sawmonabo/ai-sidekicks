// A row's output, a command's or plain text, parsed before its row is drawn into chunks of lines,
// which the row's preparation reads a slice at a time and publishes to the feed's prepared bodies;
// nothing else parses the output. A row leaving the drawn band's reach lets its parse go and waits
// on it again, and one coming back is parsed whole before it draws. A row coming into view is
// parsed whole in the task that reads it, so no frame holds it out of the box, as when a
// measurement above the reader moves the offset and brings in a row the band was still parsing, or
// one rewritten while out of view; a row already in view takes its next slice in that task, while
// no other slice ran in it; the band's others wait their turn. A listed row's output that grows
// publishes what each slice parsed, so a revision draws what is parsed and never the raw text; one
// parsed again from the start, after a rewrite or under another handle, keeps drawing its last
// parse until the new one is whole, which then replaces it. A listed body that turns into an
// output, with no parse drawn yet, draws each slice's parse as it lands.

import { startSlice } from "#renderer/lib/work-slices.js";
import { type PublishedText } from "#renderer/lib/text/published.js";
import { type OutputParse, type PreparedBodies } from "../prepared-bodies.js";
import { AnsiLineChunks } from "./lines/chunks.js";

/**
 * How near the viewport a row's output stands, which decides when it is parsed: outside
 * the drawn band's reach not at all, within it in turn, and in view, about to draw, at once.
 */
export type OutputReach = "outside" | "band" | "view";

/**
 * One row's output, parsed into chunks as its text grows, in turn with the feed's other
 * outputs, and in the task that reads the text while the row is in view: whole as it comes into
 * view, a slice after. Released with the row's preparation, which takes it out of its turn and
 * drops the row's published output.
 */
export class AnsiOutputPreparation implements OutputParse {
  readonly #rowId: string;
  readonly #outputs: PreparedBodies;
  readonly #ownerWindow: Window;
  readonly #onReady: () => void;
  /** The output's chunks being read, or `undefined` while the row's body draws no output. */
  #lineChunks: AnsiLineChunks | undefined;
  /** The output's text last read, and its revision once that is parsed whole. */
  #text: PublishedText | undefined;
  #parsedRevision: number | undefined;
  /** The generation of chunks last published, which every slice of it publishes again. */
  #publishedGeneration: number | undefined;
  #isReady = true;
  /** How near the viewport the row stood at its last read. */
  #reach: OutputReach = "outside";

  /** `onReady` is called each time a parse that waited its turn is whole. */
  public constructor(
    rowId: string,
    outputs: PreparedBodies,
    ownerWindow: Window,
    onReady: () => void,
  ) {
    this.#rowId = rowId;
    this.#outputs = outputs;
    this.#ownerWindow = ownerWindow;
    this.#onReady = onReady;
  }

  /** Whether the output's text last read is settled: parsed whole, or its parse failed. */
  public get isReady(): boolean {
    return this.#isReady;
  }

  /**
   * Reads `text`, the output the row's body draws now, parsing past what is parsed as near the
   * viewport as `reach` says; `undefined` while the body draws no output. Either drops the
   * chunks, and outside the reach the row waits on its parse until it comes back.
   */
  public read(text: PublishedText | undefined, reach: OutputReach): void {
    const isComingIntoView = reach === "view" && this.#reach !== "view";
    this.#reach = reach;
    if (text === undefined || reach === "outside") {
      this.#drop();
      this.#isReady = text === undefined;
      return;
    }
    if (text === this.#text && text.revision === this.#parsedRevision) {
      return;
    }
    this.#text = text;
    this.#parsedRevision = undefined;
    this.#lineChunks ??= new AnsiLineChunks();
    this.#isReady = false;
    // A row coming into view is drawn only once its parse is whole, whether it never had one or its
    // text was rewritten while it stood out of view, so its parse cannot wait its turn. One already
    // in view is drawn, and keeps drawing its last parse while a change of it parses.
    if (isComingIntoView) {
      this.#outputs.leaveTurn(this);
      this.#readSlice(WHOLE_PARSE);
      this.#isReady = true;
      return;
    }
    // A parse waiting its turn reads the text last read when its turn comes, so a reveal frame adds
    // no slice; and a task runs one slice at most.
    if (
      reach === "view" &&
      !this.#outputs.isInTurn(this) &&
      this.#outputs.takeSlice() &&
      this.#readSlice(startSlice())
    ) {
      this.#isReady = true;
      return;
    }
    this.#outputs.parseInTurn(this, this.#ownerWindow);
  }

  /**
   * Reads one slice of the output in its turn, answering whether its turn is over. A whole parse
   * leaves its turn and tells the row; so does one that throws, whose error goes to the window's
   * own error report and whose text is not parsed again until it changes. Never throws.
   */
  public readInTurn(hasTime: () => boolean): boolean {
    try {
      if (!this.#readSlice(hasTime)) {
        return false;
      }
    } catch (failure: unknown) {
      // The row draws what was published, and the app's diagnostics hear the error, stack and all.
      this.#parsedRevision = this.#text?.revision;
      this.#ownerWindow.reportError(failure);
    }
    this.#outputs.leaveTurn(this);
    this.#isReady = true;
    this.#onReady();
    return true;
  }

  /** Takes the output out of its turn and drops the row's published output. */
  public release(): void {
    this.#drop();
  }

  /** Reads a slice of the output's text, publishing what it parsed; answers whether it is whole. */
  #readSlice(hasTime: () => boolean): boolean {
    const text = this.#text;
    const lineChunks = this.#lineChunks;
    if (text === undefined || lineChunks === undefined) {
      throw new Error("An output was read in a slice after its text was dropped.");
    }
    const read = lineChunks.read(text, hasTime);
    // A parse from the start, while the row draws an earlier parse, publishes once whole, so the
    // row keeps drawing that meanwhile; a row that draws none draws each slice's parse.
    if (
      read.isComplete ||
      read.chunks.generation === this.#publishedGeneration ||
      this.#outputs.chunksOf(this.#rowId) === undefined
    ) {
      this.#publishedGeneration = read.chunks.generation;
      this.#outputs.publish(this.#rowId, this, read.chunks);
    }
    if (read.isComplete) {
      this.#parsedRevision = text.revision;
    }
    return read.isComplete;
  }

  #drop(): void {
    this.#outputs.leaveTurn(this);
    this.#outputs.withdraw(this.#rowId, this);
    this.#lineChunks = undefined;
    this.#text = undefined;
    this.#parsedRevision = undefined;
    this.#publishedGeneration = undefined;
    this.#isReady = true;
  }
}

/** A slice with no end: a parse that reads the text whole. */
const WHOLE_PARSE = (): boolean => true;
