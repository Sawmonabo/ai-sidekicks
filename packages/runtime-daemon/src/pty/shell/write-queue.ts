// One shell's input on its way to the terminal host: bytes reach the shell in the order they were
// admitted, one host write in flight at a time, and whatever arrives meanwhile rides the next
// write, each write no larger than the daemon's write bound. A paste of any size, sent in parts,
// goes in pieces one after another and nothing is refused or dropped.

import type { SubscriptionId } from "@ai-sidekicks/contracts/jsonrpc/streaming";

import { MAX_FRAME_BODY_BYTES } from "../sidecar/frame-codec.js";

// The longest session id the sidecar mints: `s-` and its 64-bit counter.
const LONGEST_SIDECAR_SESSION_ID = `s-${String(2n ** 64n - 1n)}`;

// The bytes of a sidecar write frame's body around the written bytes themselves.
const WRITE_FRAME_ENVELOPE_BYTES = JSON.stringify({
  kind: "write_request",
  session_id: LONGEST_SIDECAR_SESSION_ID,
  bytes: "",
}).length;

/**
 * The most bytes one write hands the terminal host: the largest piece whose base64 form, four
 * characters for every three bytes, fits one sidecar write frame beside the frame's other members,
 * so one piece is one write on either backend.
 */
export const SHELL_WRITE_BOUND_BYTES: number =
  Math.floor((MAX_FRAME_BODY_BYTES - WRITE_FRAME_ENVELOPE_BYTES) / 4) * 3;

// The marks around a bracketed paste.
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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
 * One paste on its way to a shell across the parts it was sent in. Whether it is marked as pasted
 * is fixed at its first part, by whether the program in the shell asked for bracketed paste then:
 * a marked paste is opened once before its first part and closed once after its last, with every
 * end mark inside it removed first, even one split across two parts or one that removing another
 * would form, so the pasted text cannot close the marks early.
 */
export class ShellPaste {
  /** The pane output subscription the paste is written through. */
  readonly outputSubscriptionId: SubscriptionId;
  readonly #isBracketed: boolean;
  #hasStarted = false;
  // The end of the last part that may begin an end mark, held until the next part shows.
  #heldText = "";

  constructor(isBracketed: boolean, outputSubscriptionId: SubscriptionId) {
    this.#isBracketed = isBracketed;
    this.outputSubscriptionId = outputSubscriptionId;
  }

  /** The bytes one part puts on the shell's input, the marks included where they fall. */
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

  /** The bytes that close a paste whose last part never came: what it held, and its end mark. */
  close(): Uint8Array {
    if (!this.#isBracketed) {
      return new Uint8Array(0);
    }
    const closing = `${this.#heldText}${PASTE_END}`;
    this.#heldText = "";
    return Buffer.from(closing, "utf8");
  }
}

// Bytes admitted to the shell and how far the host writes have taken them.
interface QueuedInput {
  readonly bytes: Uint8Array;
  writtenByteCount: number;
  readonly delivered: PromiseWithResolvers<void>;
}

/** The ordered input of one shell, written through `write` one piece at a time. */
export class ShellWriteQueue {
  readonly #write: (bytes: Uint8Array) => Promise<void>;
  readonly #queued: QueuedInput[] = [];
  #isWriting = false;

  constructor(write: (bytes: Uint8Array) => Promise<void>) {
    this.#write = write;
  }

  /**
   * Queues bytes behind everything queued before them. Resolves once every host write carrying
   * them has completed, and rejects with the failure of one that did not, the rest of them then
   * unwritten.
   */
  enqueue(bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) {
      return Promise.resolve();
    }
    const input: QueuedInput = { bytes, writtenByteCount: 0, delivered: Promise.withResolvers() };
    this.#queued.push(input);
    this.#writeNext();
    return input.delivered.promise;
  }

  #writeNext(): void {
    if (this.#isWriting || this.#queued.length === 0) {
      return;
    }
    const parts: Uint8Array[] = [];
    const carried: QueuedInput[] = [];
    let pieceByteCount = 0;
    for (const input of this.#queued) {
      if (pieceByteCount === SHELL_WRITE_BOUND_BYTES) {
        break;
      }
      const taken = Math.min(
        SHELL_WRITE_BOUND_BYTES - pieceByteCount,
        input.bytes.byteLength - input.writtenByteCount,
      );
      parts.push(input.bytes.subarray(input.writtenByteCount, input.writtenByteCount + taken));
      input.writtenByteCount += taken;
      pieceByteCount += taken;
      carried.push(input);
    }
    // Input the piece takes to its end leaves the queue now; the rest waits for the next piece.
    const finished = carried.filter((input) => input.writtenByteCount === input.bytes.byteLength);
    this.#queued.splice(0, finished.length);
    this.#isWriting = true;
    // Each outcome reaches the callers whose bytes the piece carried, through `delivered`.
    void this.#write(Buffer.concat(parts, pieceByteCount))
      .then(
        () => {
          for (const input of finished) {
            input.delivered.resolve();
          }
        },
        (error: unknown) => {
          for (const input of carried) {
            input.delivered.reject(error);
            const unfinishedIndex = this.#queued.indexOf(input);
            if (unfinishedIndex !== -1) {
              this.#queued.splice(unfinishedIndex, 1);
            }
          }
        },
      )
      .finally(() => {
        this.#isWriting = false;
        this.#writeNext();
      });
  }
}
