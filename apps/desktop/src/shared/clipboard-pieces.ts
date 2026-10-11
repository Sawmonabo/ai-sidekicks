// The pieces of a late copy, its text and formatted flavor or its picture's PNG bytes, held by
// whoever answers the page's clipboard calls until the write that names the copy joins them: main,
// or a fixture standing in for it. One copy is held at a time.

import type { ClipboardContent, ClipboardPiece } from "./preload-api.js";

/** The pieces held for one late copy, each flavor's in the order they were sent. */
export interface HeldClipboardCopy {
  readonly copyId: string;
  readonly text: readonly string[];
  readonly html: readonly string[];
  readonly png: readonly Uint8Array<ArrayBuffer>[];
}

/**
 * The pieces of the one late copy held, sent ahead of its write: a copy's first text or picture
 * piece takes the place of the copy held, so one copy's pieces are held at a time.
 */
export class ClipboardPieces {
  #copy: MutableClipboardCopy | undefined;

  /**
   * Takes one piece. Throws for a piece naming a copy not held, which leaves the held copy
   * standing, or one out of its flavor's order, which lets the held copy go, since a copy missing
   * a piece would look whole.
   */
  public take(piece: ClipboardPiece): void {
    const { copyId, index } = piece;
    if (piece.flavor !== "html" && index === 0) {
      this.#copy = { copyId, text: [], html: [], png: [] };
    }
    const copy = this.#piecesOf(copyId);
    if (index !== copy[piece.flavor].length) {
      this.#copy = undefined;
      throw new Error("A clipboard piece came out of order.");
    }
    if (piece.flavor === "png") {
      copy.png.push(piece.piece);
    } else {
      copy[piece.flavor].push(piece.piece);
    }
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
   * What the copy `copyId` names puts on the clipboard, its pieces joined: its picture, or its text
   * and its formatted flavor when pieces of one were sent. Throws for a copy not held.
   */
  public contentOf(copyId: string): ClipboardContent {
    const { text, html, png } = this.#piecesOf(copyId);
    if (png.length > 0) {
      const joined = new Uint8Array(png.reduce((length, piece) => length + piece.length, 0));
      let offset = 0;
      for (const piece of png) {
        joined.set(piece, offset);
        offset += piece.length;
      }
      return { png: joined };
    }
    return html.length === 0
      ? { text: text.join("") }
      : { text: text.join(""), html: html.join("") };
  }

  #piecesOf(copyId: string): MutableClipboardCopy {
    if (this.#copy?.copyId !== copyId) {
      throw new Error("A clipboard piece names a copy that is not held.");
    }
    return this.#copy;
  }
}

/** The copy held, its flavors' pieces growing as they arrive. */
interface MutableClipboardCopy {
  readonly copyId: string;
  readonly text: string[];
  readonly html: string[];
  readonly png: Uint8Array<ArrayBuffer>[];
}
