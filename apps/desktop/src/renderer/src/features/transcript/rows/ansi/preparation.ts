// A command output parsed before its row is listed, and kept while the feed's window holds the row.
// The row's preparation reads the output a slice at a time and publishes its chunks here, where the
// row's output box draws them; nothing else parses the output, so one copy of its chunks exists. A
// row is listed once its output is parsed whole. A listed row's output that grows publishes what
// each slice parsed, so a revision draws what is parsed and never the raw text; one parsed again
// from the start, after a rewrite or under another handle, keeps drawing its last parse until the
// new one is whole, which then replaces it. A listed body that turns into command output, with no
// parse drawn yet, draws each slice's parse as it lands.

import { createContext, type Context } from "react";

import { startSlice, workInSlices } from "#renderer/lib/work-slices.js";
import { type PublishedText } from "../../reveal/published-text.js";
import { AnsiLineChunks, type AnsiLineChunkList } from "./lines/chunks.js";

/**
 * The command outputs one feed's rows draw, by row id, each published by the row's preparation and
 * dropped when the window lets the row go.
 */
export class PreparedAnsiOutputs {
  readonly #outputs = new Map<string, PublishedOutput>();
  readonly #listeners = new Set<() => void>();
  #isTelling = false;

  /** Hears each output published or dropped; returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The chunks the row's output draws, or `undefined` while none is published for it. */
  public readonly chunksOf = (rowId: string): AnsiLineChunkList | undefined =>
    this.#outputs.get(rowId)?.chunks;

  /** Publishes `chunks` as the row's output for `owner`, in place of what the row drew before. */
  public publish(rowId: string, owner: AnsiOutputPreparation, chunks: AnsiLineChunkList): void {
    this.#outputs.set(rowId, { owner, chunks });
    this.#tell();
  }

  /**
   * Drops the row's output if `owner` published it; one a later preparation of the row published
   * stays, since a changed row's last version is let go after its new one is published.
   */
  public withdraw(rowId: string, owner: AnsiOutputPreparation): void {
    if (this.#outputs.get(rowId)?.owner === owner) {
      this.#outputs.delete(rowId);
      this.#tell();
    }
  }

  /**
   * Tells the listeners once the task that published ends: a row is prepared while the feed
   * renders, where its output box may not be told to render.
   */
  #tell(): void {
    if (this.#isTelling) {
      return;
    }
    this.#isTelling = true;
    queueMicrotask(() => {
      this.#isTelling = false;
      for (const listener of this.#listeners) {
        listener();
      }
    });
  }
}

/** The feed's prepared command outputs, provided around its viewport; `undefined` outside one. */
export const PreparedAnsiOutputsContext: Context<PreparedAnsiOutputs | undefined> = createContext<
  PreparedAnsiOutputs | undefined
>(undefined);

/**
 * One row's command output, parsed into chunks as its text grows: the first slice in the task that
 * reads the text, the rest in slices of their own. Released with the row's preparation, which
 * stops the slices and drops the row's published output.
 */
export class AnsiOutputPreparation {
  readonly #rowId: string;
  readonly #outputs: PreparedAnsiOutputs;
  readonly #ownerWindow: Window;
  readonly #onReady: () => void;
  /** The output's chunks being read, or `undefined` while the row's body draws no output. */
  #lineChunks: AnsiLineChunks | undefined;
  /** The output's text last read, and its revision once that is parsed whole. */
  #text: PublishedText | undefined;
  #parsedRevision: number | undefined;
  /** The generation of chunks last published, which every slice of it publishes again. */
  #publishedGeneration: number | undefined;
  #isSlicing = false;
  #isReady = true;
  #isReleased = false;

  /** `onReady` is called each time a parse that took more than one slice is whole. */
  public constructor(
    rowId: string,
    outputs: PreparedAnsiOutputs,
    ownerWindow: Window,
    onReady: () => void,
  ) {
    this.#rowId = rowId;
    this.#outputs = outputs;
    this.#ownerWindow = ownerWindow;
    this.#onReady = onReady;
  }

  /** Whether the output's text last read is parsed whole. */
  public get isReady(): boolean {
    return this.#isReady;
  }

  /**
   * Reads `text`, the output the row's body draws now, parsing past what is parsed; `undefined`
   * while the body draws no command output, which drops its chunks.
   */
  public read(text: PublishedText | undefined): void {
    if (text === undefined) {
      this.#drop();
      return;
    }
    if (text === this.#text && text.revision === this.#parsedRevision) {
      return;
    }
    this.#text = text;
    this.#parsedRevision = undefined;
    this.#lineChunks ??= new AnsiLineChunks();
    this.#isReady = false;
    // The next of the running slices reads the text last read, so a reveal frame adds no slice.
    if (this.#isSlicing) {
      return;
    }
    if (this.#readSlice(startSlice())) {
      this.#isReady = true;
      return;
    }
    this.#sliceOn();
  }

  /** Stops the slices and drops the row's published output. */
  public release(): void {
    this.#isReleased = true;
    this.#drop();
  }

  /** Reads a slice of the output's text, publishing what it parsed; answers whether it is whole. */
  #readSlice(hasTime: () => boolean): boolean {
    const text = this.#text;
    const lineChunks = this.#lineChunks;
    if (text === undefined || lineChunks === undefined) {
      throw new Error("A command output was read in a slice after its text was dropped.");
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

  /** Reads the rest of the output in slices of their own, and tells the row once it is whole. */
  #sliceOn(): void {
    this.#isSlicing = true;
    void workInSlices(
      this.#ownerWindow,
      (hasTime) => this.#readSlice(hasTime),
      () => this.#isReleased || this.#lineChunks === undefined,
    ).then((isWhole) => {
      this.#isSlicing = false;
      if (isWhole) {
        this.#isReady = true;
        this.#onReady();
      }
    });
  }

  #drop(): void {
    this.#outputs.withdraw(this.#rowId, this);
    this.#lineChunks = undefined;
    this.#text = undefined;
    this.#parsedRevision = undefined;
    this.#publishedGeneration = undefined;
    this.#isReady = true;
  }
}

/** One row's published output and the preparation that published it. */
interface PublishedOutput {
  readonly owner: AnsiOutputPreparation;
  readonly chunks: AnsiLineChunkList;
}
