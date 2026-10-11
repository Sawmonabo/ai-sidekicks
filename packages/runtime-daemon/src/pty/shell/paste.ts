// A shell's pastes on their way in, each sent in parts. Whether a paste is marked as pasted is
// fixed at its first part, by whether the program in the shell asked for bracketed paste then. A
// shell has at most one paste open, which belongs to the pane output subscription its newest part
// came through: a paste another part starts closes the open one first, so two panes' pastes never
// interleave and the program is never left inside a paste. An answer to the program that comes
// while a marked paste is open waits for its end mark, so it never lands inside the pasted text.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

// The marks around a bracketed paste.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const NO_BYTES = new Uint8Array(0);

// The longest end of a part that may begin an end mark the next part completes.
function heldEndMarkPrefixLength(text: string): number {
  for (let length = Math.min(PASTE_END.length - 1, text.length); length > 0; length -= 1) {
    if (text.endsWith(PASTE_END.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

/**
 * One paste across the parts it was sent in. A marked paste is opened once before its first part
 * and closed once after its last, with every end mark inside it removed first, even one split
 * across two parts or one that removing another would form, so the pasted text cannot close the
 * marks early.
 */
class ShellPaste {
  readonly #isBracketed: boolean;
  #hasStarted = false;
  // The end of the last part that may begin an end mark, held until the next part shows.
  #heldText = "";
  // The answers to the program that came while the paste was open, written after its end mark.
  readonly #heldAnswers: Uint8Array[] = [];

  constructor(isBracketed: boolean) {
    this.#isBracketed = isBracketed;
  }

  // The bytes one part puts on the shell's input, the marks included where they fall.
  encodePart(data: string, isLastPart: boolean): Uint8Array {
    if (!this.#isBracketed) {
      return Buffer.from(data, "utf8");
    }
    const opening = this.#hasStarted ? "" : PASTE_START;
    this.#hasStarted = true;
    let pasted = `${this.#heldText}${data}`;
    while (pasted.includes(PASTE_END)) {
      pasted = pasted.replaceAll(PASTE_END, "");
    }
    if (isLastPart) {
      this.#heldText = "";
      return Buffer.concat([
        Buffer.from(`${opening}${pasted}${PASTE_END}`, "utf8"),
        ...this.#heldAnswers.splice(0),
      ]);
    }
    const keptLength = pasted.length - heldEndMarkPrefixLength(pasted);
    this.#heldText = pasted.slice(keptLength);
    return Buffer.from(`${opening}${pasted.slice(0, keptLength)}`, "utf8");
  }

  // The bytes that close a paste whose last part never came: what it held, its end mark and the
  // answers that waited for it.
  close(): Uint8Array {
    if (!this.#isBracketed) {
      return NO_BYTES;
    }
    const closing = `${this.#heldText}${PASTE_END}`;
    this.#heldText = "";
    return Buffer.concat([Buffer.from(closing, "utf8"), ...this.#heldAnswers.splice(0)]);
  }

  // Holds an answer until the end mark when the paste is marked; a paste with no marks holds none.
  holdAnswer(answer: Uint8Array): boolean {
    if (!this.#isBracketed) {
      return false;
    }
    this.#heldAnswers.push(answer);
    return true;
  }
}

/** One part of a paste, as a write frame carries it. */
export interface ShellPastePart {
  readonly pasteId: string;
  readonly outputSubscriptionId: SubscriptionId;
  readonly data: string;
  readonly isLastPart: boolean;
}

/** A shell's pastes, at most one of them open at a time. */
export class ShellPastes {
  #open: {
    readonly pasteId: string;
    readonly owner: SubscriptionId;
    readonly paste: ShellPaste;
  } | null = null;

  /**
   * The bytes one part puts on the shell's input: what closes the open paste when this part starts
   * another, then the part itself. `isBracketed` is read only for a first part.
   */
  encodePart(part: ShellPastePart, isBracketed: () => boolean): Uint8Array {
    const open = this.#open?.pasteId === part.pasteId ? this.#open : null;
    const displaced = open === null ? this.closeAll() : NO_BYTES;
    const paste = open?.paste ?? new ShellPaste(isBracketed());
    this.#open = part.isLastPart
      ? null
      : { pasteId: part.pasteId, owner: part.outputSubscriptionId, paste };
    return Buffer.concat([displaced, paste.encodePart(part.data, part.isLastPart)]);
  }

  /** The bytes that close the paste open through a pane, which closes; none when it has none. */
  closeFor(outputSubscriptionId: SubscriptionId): Uint8Array {
    return this.#open?.owner === outputSubscriptionId ? this.closeAll() : NO_BYTES;
  }

  /** The bytes that close the paste `pasteId`, which closes; none when it is not open. */
  closePaste(pasteId: string): Uint8Array {
    return this.#open?.pasteId === pasteId ? this.closeAll() : NO_BYTES;
  }

  /** The bytes that close the open paste, whichever pane it came through; none when none is. */
  closeAll(): Uint8Array {
    const open = this.#open;
    this.#open = null;
    return open === null ? NO_BYTES : open.paste.close();
  }

  /**
   * Holds an answer to the program until the open paste's end mark, which the bytes that close it
   * carry after them, when that paste is marked as pasted; whether it held it.
   */
  holdAnswer(answer: Uint8Array): boolean {
    return this.#open?.paste.holdAnswer(answer) ?? false;
  }

  /** Forgets the open paste and the answers it held, for a shell that takes no more input. */
  clear(): void {
    this.#open = null;
  }
}
