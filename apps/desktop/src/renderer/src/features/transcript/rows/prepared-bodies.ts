// What a feed's rows draw as their preparations readied it, kept while each row is within the
// drawn band's reach: an output's chunks of lines and a reply's markdown text. A row's preparation
// publishes each here, where the row's body draws it, so one copy exists, and drops it when the
// window lets the row go. The outputs waiting on their parse are parsed here in turn, one slice per
// task, the output that came into reach last first.

import { createContext, type Context } from "react";

import { workInSlices } from "#renderer/lib/work-slices.js";
import { type PublishedText } from "../reveal/published-text.js";
import { type AnsiLineChunkList } from "./ansi/lines/chunks.js";

/** One output's parse waiting its turn, read a slice at a time. */
export interface OutputParse {
  /** Reads one slice of the parse, answering whether it is whole. */
  readInTurn(hasTime: () => boolean): boolean;
}

/**
 * What one feed's rows draw as their preparation readied it, by row id: an output's chunks of
 * lines, and a reply's markdown text; each is published by the row's preparation and dropped when
 * the window lets the row go.
 */
export class PreparedBodies {
  readonly #outputs = new Map<string, PublishedOutput>();
  readonly #markdownTexts = new Map<string, PublishedMarkdownText>();
  readonly #listeners = new Set<() => void>();
  /** The outputs waiting on their parse, the one to parse next last. */
  readonly #parsesInTurn: OutputParse[] = [];
  #isParsing = false;
  /** Whether a slice of parsing ran in the task under way. */
  #isSliceTaken = false;
  #isTelling = false;

  /** Hears each output or markdown text published or dropped; returns the unsubscribe. */
  public readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The chunks the row's output draws, or `undefined` while none is published for it. */
  public readonly chunksOf = (rowId: string): AnsiLineChunkList | undefined =>
    this.#outputs.get(rowId)?.chunks;

  /** The reply's text its body draws as markdown, or `undefined` while none is published for it. */
  public readonly markdownTextOf = (rowId: string): PublishedText | undefined =>
    this.#markdownTexts.get(rowId)?.text;

  /**
   * Publishes `text` as the reply's markdown for `owner`; a handle already published tells no one,
   * as its body reads each revision as it draws.
   */
  public publishMarkdownText(rowId: string, owner: object, text: PublishedText): void {
    const published = this.#markdownTexts.get(rowId);
    if (published?.owner === owner && published.text === text) {
      return;
    }
    this.#markdownTexts.set(rowId, { owner, text });
    this.#tell();
  }

  /** Drops the reply's markdown text if `owner` published it, as `withdraw` drops an output. */
  public withdrawMarkdownText(rowId: string, owner: object): void {
    if (this.#markdownTexts.get(rowId)?.owner === owner) {
      this.#markdownTexts.delete(rowId);
      this.#tell();
    }
  }

  /** Publishes `chunks` as the row's output for `owner`, in place of what the row drew before. */
  public publish(rowId: string, owner: OutputParse, chunks: AnsiLineChunkList): void {
    this.#outputs.set(rowId, { owner, chunks });
    this.#tell();
  }

  /**
   * Drops the row's output if `owner` published it; one a later preparation of the row published
   * stays, since a changed row's last version is let go after its new one is published.
   */
  public withdraw(rowId: string, owner: OutputParse): void {
    if (this.#outputs.get(rowId)?.owner === owner) {
      this.#outputs.delete(rowId);
      this.#tell();
    }
  }

  /**
   * Parses `parse` ahead of every output waiting, a slice per task in `view`, until it is whole or
   * leaves its turn.
   */
  public parseInTurn(parse: OutputParse, view: Window): void {
    this.leaveTurn(parse);
    this.#parsesInTurn.push(parse);
    if (!this.#isParsing) {
      this.#parseInSlices(view);
    }
  }

  /** Takes `parse` out of the parses waiting, if it waits. */
  public leaveTurn(parse: OutputParse): void {
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
  public isInTurn(parse: OutputParse): boolean {
    return this.#parsesInTurn.includes(parse);
  }

  /**
   * Parses the waiting outputs a slice per task, the next first, until none waits. An output whose
   * parse throws leaves its turn and its error reaches the page, and the outputs behind it parse.
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
          // A whole parse leaves its turn; one that is not has spent the slice.
          if (!this.#readInTurn(next, hasTime) || !hasTime()) {
            return this.#parsesInTurn.length === 0;
          }
        }
      },
      () => false,
    ).finally(() => {
      this.#isParsing = false;
      // An output its last slice's tell put back in turn, or one behind an output that threw.
      if (this.#parsesInTurn.length > 0) {
        this.#parseInSlices(view);
      }
    });
  }

  /** Reads a slice of `parse`; one that throws leaves its turn, so none reads it. */
  #readInTurn(parse: OutputParse, hasTime: () => boolean): boolean {
    try {
      return parse.readInTurn(hasTime);
    } catch (error) {
      this.leaveTurn(parse);
      throw error;
    }
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
  readonly owner: OutputParse;
  readonly chunks: AnsiLineChunkList;
}

/** One reply's published markdown text and the preparation that published it. */
interface PublishedMarkdownText {
  readonly owner: object;
  readonly text: PublishedText;
}
