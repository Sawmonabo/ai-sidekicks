// What a feed's rows draw as their preparations readied it, kept while each row is within the
// drawn band's reach: an output's chunks of lines and a message's markdown text with the reader of
// its blocks. A row's preparation publishes each here, where the row's body draws it, so one copy
// exists, and drops it when the window lets the row go. The parses waiting, an output's and the
// reads of a message's drawn blocks, run here in turn, one slice per task, the one that came into
// reach last first; a parse whose slice throws leaves its turn, so no failure holds the others or
// runs again on its own.

import { createContext, type Context } from "react";

import { workInSlices } from "#renderer/lib/work-slices.js";
import { type PublishedText } from "#renderer/lib/text/published.js";
import { type AnsiLineChunkList } from "./ansi/lines/chunks.js";
import { type MarkdownBodyBlocks } from "./markdown/body-blocks/reader.js";

/**
 * One row's parse waiting its turn, read a slice at a time: its output's, or the reads of its drawn
 * blocks.
 */
export interface RowParse {
  /**
   * Reads one slice of the parse, answering whether its turn is over. A parse that fails settles
   * and reports its own failure; what throws past it, such as a row's own callback, takes it out of
   * its turn.
   */
  readInTurn(hasTime: () => boolean): boolean;
}

/** A message's markdown as its row's preparation reads it, which its body draws. */
export interface PreparedMarkdownBody {
  readonly text: PublishedText;
  readonly isComplete: boolean;
  /** The reader of the body's blocks, which the body reads with the same text. */
  readonly blocks: MarkdownBodyBlocks;
}

/**
 * What one feed's rows draw as their preparation readied it, by row id: an output's chunks of
 * lines, and a message's markdown body; each is published by the row's preparation and dropped
 * when the window lets the row go.
 */
export class PreparedBodies {
  readonly #outputs = new Map<string, PublishedOutput>();
  readonly #markdownBodies = new Map<string, PublishedMarkdownBody>();
  readonly #listeners = new Set<() => void>();
  /** The parses waiting their turn, the one to read next last. */
  readonly #parsesInTurn: RowParse[] = [];
  #isParsing = false;
  /** Whether a slice of parsing ran in the task under way. */
  #isSliceTaken = false;
  #isTelling = false;

  /** Hears each output or markdown body published or dropped; returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The chunks the row's output draws, or `undefined` while none is published for it. */
  public readonly chunksOf = (rowId: string): AnsiLineChunkList | undefined =>
    this.#outputs.get(rowId)?.chunks;

  /** The message's markdown its body draws, or `undefined` while none is published for it. */
  public readonly markdownBodyOf = (rowId: string): PreparedMarkdownBody | undefined =>
    this.#markdownBodies.get(rowId)?.body;

  /**
   * Publishes `body` as the message's markdown for `owner`; a handle already published, finished or
   * not as before and with the same reader, tells no one, as its body reads each revision as it
   * draws.
   */
  public publishMarkdownBody(rowId: string, owner: object, body: PreparedMarkdownBody): void {
    const published = this.#markdownBodies.get(rowId);
    if (
      published?.owner === owner &&
      published.body.text === body.text &&
      published.body.isComplete === body.isComplete &&
      published.body.blocks === body.blocks
    ) {
      return;
    }
    this.#markdownBodies.set(rowId, { owner, body });
    this.#tell();
  }

  /** Drops the message's markdown body if `owner` published it, as `withdraw` drops an output. */
  public withdrawMarkdownBody(rowId: string, owner: object): void {
    if (this.#markdownBodies.get(rowId)?.owner === owner) {
      this.#markdownBodies.delete(rowId);
      this.#tell();
    }
  }

  /** Publishes `chunks` as the row's output for `owner`, in place of what the row drew before. */
  public publish(rowId: string, owner: RowParse, chunks: AnsiLineChunkList): void {
    this.#outputs.set(rowId, { owner, chunks });
    this.#tell();
  }

  /**
   * Drops the row's output if `owner` published it; one a later preparation of the row published
   * stays, since a changed row's last version is let go after its new one is published.
   */
  public withdraw(rowId: string, owner: RowParse): void {
    if (this.#outputs.get(rowId)?.owner === owner) {
      this.#outputs.delete(rowId);
      this.#tell();
    }
  }

  /**
   * Reads `parse` ahead of every parse waiting, a slice per task in `view`, until it is whole or
   * leaves its turn.
   */
  public parseInTurn(parse: RowParse, view: Window): void {
    this.leaveTurn(parse);
    this.#parsesInTurn.push(parse);
    if (!this.#isParsing) {
      this.#parseInSlices(view);
    }
  }

  /** Takes `parse` out of the parses waiting, if it waits. */
  public leaveTurn(parse: RowParse): void {
    const position = this.#parsesInTurn.indexOf(parse);
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

  /** Whether `parse` waits its turn. */
  public isInTurn(parse: RowParse): boolean {
    return this.#parsesInTurn.includes(parse);
  }

  /**
   * Reads the waiting parses a slice per task, the next first, until none waits. A parse whose read
   * throws leaves its turn, its error going to `view`'s error report once, and the next is read. A
   * view that cannot run a slice is reported, and tried again only by the next parse put in turn.
   */
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
          let isTurnOver: boolean;
          try {
            isTurnOver = next.readInTurn(hasTime);
          } catch (failure: unknown) {
            this.leaveTurn(next);
            view.reportError(failure);
            isTurnOver = true;
          }
          // A parse whose turn is over leaves it; one whose turn is not has spent the slice.
          if (!isTurnOver || !hasTime()) {
            return this.#parsesInTurn.length === 0;
          }
        }
      },
      () => false,
    ).then(
      () => {
        this.#isParsing = false;
        // A parse the last slice's tell put back in turn.
        if (this.#parsesInTurn.length > 0) {
          this.#parseInSlices(view);
        }
      },
      (failure: unknown) => {
        this.#isParsing = false;
        view.reportError(failure);
      },
    );
  }

  /**
   * Tells the listeners once the task that published ends: a row is prepared while the feed
   * renders, where its body may not be told to render.
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

/** The feed's prepared bodies, provided around its viewport; `undefined` outside one. */
export const PreparedBodiesContext: Context<PreparedBodies | undefined> = createContext<
  PreparedBodies | undefined
>(undefined);

/** One row's published output and the preparation that published it. */
interface PublishedOutput {
  readonly owner: RowParse;
  readonly chunks: AnsiLineChunkList;
}

/** One message's published markdown body and the preparation that published it. */
interface PublishedMarkdownBody {
  readonly owner: object;
  readonly body: PreparedMarkdownBody;
}
