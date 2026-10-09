// One shell's input on its way to the terminal host: bytes reach the shell in the order they were
// admitted, one host write in flight at a time, and whatever arrives meanwhile rides the next
// write, each write no larger than the daemon's write bound. A paste of any size, sent in parts,
// goes in pieces one after another and nothing is refused or dropped. A write is done once the
// terminal host has written its bytes to the terminal, so a caller that waits for each pastes no
// faster than the program in the shell reads.

import { MAX_FRAME_BODY_BYTES } from "../../sidecar/frame-codec.js";

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
