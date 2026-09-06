// The chunk loop: one bounded slice at a time, from the offset the daemon last
// acknowledged.
//
// SPLIT FROM `attachment-ingest-stream.ts` BECAUSE IT IS A LOOP AND THEY ARE CALLS.
// Open and complete are one request each with one answer to read; this is a loop that
// slices a `Blob`, reads bytes off the participant's own disk, encodes them, and moves
// an offset that only the daemon may move — with three answers that are unusable and a
// payload read that can fail for a reason no growth call can. Its own subject, its own
// failure vocabulary, its own module.
//
// THE OFFSET IS THE DAEMON'S, NOT THIS CLIENT'S. Each chunk is answered with
// `{ ingestId, receivedBytes }` — the spooled running total of DECODED bytes, which is
// the bound the daemon enforces — and the ledger advances to THAT rather than by the
// slice this client happened to send. Charting the local count made the progress figure
// a record of what went on the wire, which stops being the same number the moment
// anything is dropped or replayed, and left the client unable to say which stream had
// even been acknowledged. `attachment-ingest-acknowledgement.ts` owns the three answers
// that are unusable and why each one stops the stream instead of being rounded off.
//
// THE BYTES ARE SENT, NOT DESCRIBED. Each chunk carries the base64 of one slice read
// out of the participant's own `Blob`. A request that described a size and carried no
// payload would let this client advance its ledger and call Complete over a stream the
// daemon received nothing on — minting an empty artifact rather than the file. The
// slice bounds memory too: `ATTACHMENT_CHUNK_BYTE_CAP` raw bytes at a time, so a
// hundred-megabyte upload never holds more than one chunk.
//
// RETRY REPLAYS, IT DOES NOT RESTART. A replayed chunk — same sequence number, same
// bytes — is acknowledged without being re-appended, so a lost response resumes at the
// current offset rather than restarting the upload. The two codes whose disposition
// differs are named and classified in `attachment-policy.ts`; this file acts on that
// and invents no policy.
//
// A PARTICIPANT CAN ACT WHILE A CALL IS IN FLIGHT, so every continuation re-reads the
// ledger after its await and proceeds only if the entry still stands where it stood. A
// stream stopped mid-chunk would otherwise run on to completion.

import type { ConsoleBridge } from "../../bridge/index.js";
import { ATTACHMENT_CHUNK_BYTE_CAP, encodeBase64, type ConsoleClock } from "../../core/index.js";
import {
  CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE,
  readChunkAcknowledgement,
  type ChunkAcknowledgement,
} from "./attachment-ingest-acknowledgement.js";
import { answerOrRefusal, type PortAnswer } from "./attachment-ingest-answer.js";
import { writeIngestRefusal, type AttachmentIngestLedger } from "./attachment-ingest-ledger.js";
import { isSendingAttachmentIngestEntry } from "./attachment-shapes.js";

/** What each leg is called in the one sentence that says which call failed. */
const INGEST_PAYLOAD_READ_LEG = "The payload read";
const INGEST_CHUNK_LEG = "The chunk send";

export interface AttachmentChunkStreamOptions {
  readonly bridge: ConsoleBridge;
  readonly clock: ConsoleClock;
  readonly ledger: AttachmentIngestLedger;
}

/** One open stream's bytes, sent cap-sized slice by cap-sized slice. */
export class AttachmentChunkStream {
  readonly #bridge: ConsoleBridge;
  readonly #clock: ConsoleClock;
  readonly #ledger: AttachmentIngestLedger;

  public constructor(options: AttachmentChunkStreamOptions) {
    this.#bridge = options.bridge;
    this.#clock = options.clock;
    this.#ledger = options.ledger;
  }

  /**
   * `AttachmentIngestChunk`, one bounded slice at a time from the current offset.
   *
   * The ledger IS the offset, so a resumed stream re-reads and re-sends the slice that
   * was in flight when the response was lost and the daemon acknowledges it without
   * re-appending. Which is also why the sequence number is derived from the ledger
   * rather than counted in a field of its own: every chunk but the last is exactly one
   * cap wide and the loop ends on the last, so the count of acknowledged chunks is the
   * offset divided by the cap — and a replay recomputes the same number from the same
   * offset, which is exactly what the daemon's idempotent acknowledgement matches on.
   *
   * AND THE OFFSET MOVES ONLY WHERE THE DAEMON SAYS IT DID. The ledger takes the reply's
   * own `receivedBytes` once the reply has been checked against the stream this chunk
   * was sent on; an acknowledgement that names another stream, carries no total, or
   * fails to advance is a refusal on this ingest rather than a number rounded into the
   * ledger. The advance check is also what makes this loop terminate on the daemon's
   * answer: the offset is the ledger, so a total that stood still would re-slice from
   * the same place for as long as the daemon kept answering.
   */
  public async send(localId: string): Promise<boolean> {
    for (;;) {
      const entry = this.#ledger.current(localId);
      const stamp = this.#ledger.stamp(localId);
      if (
        entry === undefined ||
        stamp === undefined ||
        // The bytes live on the sending arm of the entry only, so this narrowing is
        // what reaches them at all: an entry that settled underneath this loop has
        // released its payload and there is nothing left here to slice.
        !isSendingAttachmentIngestEntry(entry) ||
        entry.ingestId === undefined
      ) {
        return false;
      }
      // Bound outside the thunks below, because a narrowing this loop established does
      // not follow a dotted name across a function boundary.
      const ingestId = entry.ingestId;
      const payload = entry.payload;
      const offset = entry.receivedBytes;
      if (payload.size - offset <= 0) {
        return true;
      }
      const slice = payload.slice(offset, offset + ATTACHMENT_CHUNK_BYTE_CAP);
      // The read goes through the same door as the three calls, because it fails the
      // same way: a `Blob` off a picker points at a file on disk, and a participant who
      // moved or deleted it between two chunks gets a rejecting `arrayBuffer()` rather
      // than an answer. Unhandled, that left an upload sitting at `ingesting` with the
      // file already gone.
      const read = await answerOrRefusal(INGEST_PAYLOAD_READ_LEG, async () => ({
        status: "served" as const,
        value: new Uint8Array(await slice.arrayBuffer()),
      }));
      const readSettled = this.#ledger.currentIfUnchanged(localId, stamp);
      if (readSettled === undefined) {
        return false;
      }
      if (read.status !== "served" || read.value === undefined) {
        writeIngestRefusal(this.#ledger, localId, readSettled, read);
        return false;
      }
      const bytes = read.value;
      const answer: PortAnswer<ChunkAcknowledgement> = await answerOrRefusal(
        INGEST_CHUNK_LEG,
        async () =>
          this.#bridge.growth.artifactIngestWriteChunk({
            ingestId,
            sequenceNumber: Math.floor(offset / ATTACHMENT_CHUNK_BYTE_CAP),
            chunk: encodeBase64(bytes),
          }),
      );
      const settled = this.#ledger.currentIfUnchanged(localId, stamp);
      if (settled === undefined) {
        // Abandoned or removed mid-chunk. `abandon` already asked for this spool back,
        // because the ingest id was in the ledger for it to find.
        return false;
      }
      if (answer.status !== "served") {
        writeIngestRefusal(this.#ledger, localId, settled, answer);
        return false;
      }
      const acknowledgement = readChunkAcknowledgement(settled, ingestId, answer.value);
      if (acknowledgement.status === "unusable") {
        // `restart` rather than the retry-in-place default, and it is passed rather than
        // mapped: that default assumes this client and the daemon still agree on the
        // offset, which is precisely the assumption this answer has broken.
        writeIngestRefusal(
          this.#ledger,
          localId,
          settled,
          {
            status: "unavailable",
            code: CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE,
            detail: acknowledgement.detail,
          },
          "restart",
        );
        return false;
      }
      this.#ledger.write(localId, {
        ...settled,
        receivedBytes: acknowledgement.receivedBytes,
        lastProgressAtMilliseconds: this.#clock.now(),
      });
    }
  }
}
