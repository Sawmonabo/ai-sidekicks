// A shell's pastes on their way in, each sent in parts. Whether a paste is marked as pasted is
// fixed at its first part, by whether the program in the shell asked for bracketed paste then. A
// paste belongs to the pane output subscription its newest part came through, and each pane has
// at most one paste open: a pane that starts another closes its earlier one first, so the program
// is never left inside a paste and what a shell keeps open is bounded by its panes.

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
      return Buffer.from(`${opening}${pasted}${PASTE_END}`, "utf8");
    }
    const keptLength = pasted.length - heldEndMarkPrefixLength(pasted);
    this.#heldText = pasted.slice(keptLength);
    return Buffer.from(`${opening}${pasted.slice(0, keptLength)}`, "utf8");
  }

  // The bytes that close a paste whose last part never came: what it held, and its end mark.
  close(): Uint8Array {
    if (!this.#isBracketed) {
      return NO_BYTES;
    }
    const closing = `${this.#heldText}${PASTE_END}`;
    this.#heldText = "";
    return Buffer.from(closing, "utf8");
  }
}

/** One part of a paste, as a write frame carries it. */
export interface ShellPastePart {
  readonly pasteId: string;
  readonly outputSubscriptionId: SubscriptionId;
  readonly data: string;
  readonly isLastPart: boolean;
}

/** The open pastes of one shell, at most one per pane output subscription. */
export class ShellPastes {
  readonly #open = new Map<SubscriptionId, { readonly pasteId: string; paste: ShellPaste }>();

  /**
   * The bytes one part puts on the shell's input: what closes the pane's earlier open paste when
   * this part starts another, then the part itself. `isBracketed` is read only for a first part.
   */
  encodePart(part: ShellPastePart, isBracketed: () => boolean): Uint8Array {
    const owner = this.#ownerOf(part.pasteId);
    const open = owner === undefined ? undefined : this.#open.get(owner);
    if (owner !== undefined) {
      this.#open.delete(owner);
    }
    const displaced = this.closeFor(part.outputSubscriptionId);
    const paste = open?.paste ?? new ShellPaste(isBracketed());
    if (!part.isLastPart) {
      this.#open.set(part.outputSubscriptionId, { pasteId: part.pasteId, paste });
    }
    return Buffer.concat([displaced, paste.encodePart(part.data, part.isLastPart)]);
  }

  /** The bytes that close the paste open through a pane, which closes; none when it has none. */
  closeFor(outputSubscriptionId: SubscriptionId): Uint8Array {
    const open = this.#open.get(outputSubscriptionId);
    if (open === undefined) {
      return NO_BYTES;
    }
    this.#open.delete(outputSubscriptionId);
    return open.paste.close();
  }

  /** The bytes that close the paste `pasteId`, which closes; none when it is not open. */
  closePaste(pasteId: string): Uint8Array {
    const owner = this.#ownerOf(pasteId);
    return owner === undefined ? NO_BYTES : this.closeFor(owner);
  }

  /** Forgets every open paste, for a shell that takes no more input. */
  clear(): void {
    this.#open.clear();
  }

  #ownerOf(pasteId: string): SubscriptionId | undefined {
    for (const [outputSubscriptionId, open] of this.#open) {
      if (open.pasteId === pasteId) {
        return outputSubscriptionId;
      }
    }
    return undefined;
  }
}
