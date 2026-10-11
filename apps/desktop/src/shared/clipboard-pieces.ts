// The pieces of a late copy's text and formatted flavor, held by whoever answers the page's
// clipboard calls until the write that names the copy joins them: main, or a fixture standing in
// for it. One copy is held at a time.

import type { ClipboardPiece, TextClipboardContent } from "./preload-api.js";

/** The pieces held for one late copy, each flavor's in the order they were sent. */
export interface HeldClipboardCopy {
  readonly copyId: string;
  readonly text: readonly string[];
  readonly html: readonly string[];
}

/**
 * The pieces of the one late copy held, sent ahead of its write: a copy's first text piece takes
 * the place of the copy held, so one copy's text is held at a time.
 */
export class ClipboardPieces {
  #copy: { readonly copyId: string; readonly text: string[]; readonly html: string[] } | undefined;

  /**
   * Takes one piece. Throws for a piece naming a copy not held, which leaves the held copy
   * standing, or one out of its flavor's order, which lets the held copy go, since a copy missing
   * a piece would look whole.
   */
  public take({ copyId, flavor, index, piece }: ClipboardPiece): void {
    if (flavor === "text" && index === 0) {
      this.#copy = { copyId, text: [piece], html: [] };
      return;
    }
    const pieces = this.#piecesOf(copyId)[flavor];
    if (index !== pieces.length) {
      this.#copy = undefined;
      throw new Error("A clipboard piece came out of order.");
    }
    pieces.push(piece);
  }

  /** Lets the copy `copyId` names go, when it is the one held. */
  public drop(copyId: string): void {
    if (this.#copy?.copyId === copyId) {
      this.#copy = undefined;
    }
  }

  /** Whether the copy `copyId` names is still the one held. */
  public isHeld(copyId: string): boolean {
    return this.#copy?.copyId === copyId;
  }

  /** The pieces held for the copy `copyId` names, unjoined. Throws for a copy not held. */
  public copyOf(copyId: string): HeldClipboardCopy {
    return this.#piecesOf(copyId);
  }

  /**
   * The text of the copy `copyId` names, and its formatted flavor when pieces of one were sent.
   * Throws for a copy not held.
   */
  public contentOf(copyId: string): TextClipboardContent {
    const { text, html } = this.#piecesOf(copyId);
    return html.length === 0
      ? { text: text.join("") }
      : { text: text.join(""), html: html.join("") };
  }

  #piecesOf(copyId: string): {
    readonly copyId: string;
    readonly text: string[];
    readonly html: string[];
  } {
    if (this.#copy?.copyId !== copyId) {
      throw new Error("A clipboard piece names a copy that is not held.");
    }
    return this.#copy;
  }
}
