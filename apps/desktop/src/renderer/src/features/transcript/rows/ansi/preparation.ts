// A command output parsed before its row is drawn, and kept while the row is within the drawn
// band's reach. The row's preparation reads the output a slice at a time and publishes its chunks
// here, where the row's output box draws them; nothing else parses the output, so one copy of its
// chunks exists. A row leaving the reach lets its parse go and waits on it again, and one coming
// back is parsed whole before it draws. The feed's outputs are parsed in turn, one slice per task,
// the output that came into reach last first; only a row about to draw in view takes its first
// slice in the task that reads it, while no other slice ran in that task. A listed row's output
// that grows publishes what each slice parsed, so a revision draws what is parsed and never the raw
// text; one parsed again from the start, after a rewrite or under another handle, keeps drawing its
// last parse until the new one is whole, which then replaces it. A listed body that turns into
// command output, with no parse drawn yet, draws each slice's parse as it lands.

import { createContext, type Context } from "react";

import { startSlice, workInSlices } from "#renderer/lib/work-slices.js";
import { type PublishedText } from "../../reveal/published-text.js";
import { AnsiLineChunks, type AnsiLineChunkList } from "./lines/chunks.js";

/**
 * How near the viewport a row's command output stands, which decides when it is parsed: outside
 * the drawn band's reach not at all, within it in turn, and in view, about to draw, at once.
 */
export type OutputReach = "outside" | "band" | "view";

/**
 * The command outputs one feed's rows draw, by row id, each published by the row's preparation and
 * dropped when the window lets the row go.
 */
export class PreparedAnsiOutputs {
  readonly #outputs = new Map<string, PublishedOutput>();
  readonly #listeners = new Set<() => void>();
  /** The outputs waiting on their parse, the one to parse next last. */
  readonly #parsesInTurn: AnsiOutputPreparation[] = [];
  #isParsing = false;
  /** Whether a slice of parsing ran in the task under way. */
  #isSliceTaken = false;
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
   * Parses `preparation`'s output ahead of every output waiting, a slice per task in `view`, until
   * it is whole or leaves its turn.
   */
  public parseInTurn(preparation: AnsiOutputPreparation, view: Window): void {
    this.leaveTurn(preparation);
    this.#parsesInTurn.push(preparation);
    if (!this.#isParsing) {
      this.#parseInSlices(view);
    }
  }

  /** Takes `preparation` out of the parses waiting, if it waits. */
  public leaveTurn(preparation: AnsiOutputPreparation): void {
    const position = this.#parsesInTurn.indexOf(preparation);
    if (position !== -1) {
      this.#parsesInTurn.splice(position, 1);
    }
  }

  /**
   * Takes the one slice of parsing the task under way may run, answering false once a slice ran in
   * it, so a render that brings several rows into view parses one of them at once.
   */
  public takeSlice(): boolean {
    if (this.#isSliceTaken) {
      return false;
    }
    this.#isSliceTaken = true;
    queueMicrotask(() => {
      this.#isSliceTaken = false;
    });
    return true;
  }

  /** Whether `preparation`'s output waits on a parse in turn. */
  public isInTurn(preparation: AnsiOutputPreparation): boolean {
    return this.#parsesInTurn.includes(preparation);
  }

  /** Parses the waiting outputs a slice per task, the next first, until none waits. */
  #parseInSlices(view: Window): void {
    this.#isParsing = true;
    void workInSlices(
      view,
      (hasTime) => {
        this.takeSlice();
        for (;;) {
          const next = this.#parsesInTurn.at(-1);
          if (next === undefined) {
            return true;
          }
          // A whole parse leaves its turn; one that is not has spent the slice.
          if (!next.readInTurn(hasTime) || !hasTime()) {
            return this.#parsesInTurn.length === 0;
          }
        }
      },
      () => false,
    ).then(() => {
      this.#isParsing = false;
      // An output its last slice's tell put back in turn.
      if (this.#parsesInTurn.length > 0) {
        this.#parseInSlices(view);
      }
    });
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
 * One row's command output, parsed into chunks as its text grows, in turn with the feed's other
 * outputs, the first slice in the task that reads the text while the row is in view. Released with
 * the row's preparation, which takes it out of its turn and drops the row's published output.
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
  #isReady = true;

  /** `onReady` is called each time a parse that waited its turn is whole. */
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
   * Reads `text`, the output the row's body draws now, parsing past what is parsed as near the
   * viewport as `reach` says; `undefined` while the body draws no command output. Either drops the
   * chunks, and outside the reach the row waits on its parse until it comes back.
   */
  public read(text: PublishedText | undefined, reach: OutputReach): void {
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
   * Reads one slice of the output in its turn, answering whether it is whole; a whole parse leaves
   * its turn and tells the row.
   */
  public readInTurn(hasTime: () => boolean): boolean {
    if (!this.#readSlice(hasTime)) {
      return false;
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

/** One row's published output and the preparation that published it. */
interface PublishedOutput {
  readonly owner: AnsiOutputPreparation;
  readonly chunks: AnsiLineChunkList;
}
