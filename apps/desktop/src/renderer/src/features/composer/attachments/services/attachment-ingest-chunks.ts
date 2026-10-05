// The chunk loop: one bounded slice of the user's `Blob` at a time, from the offset the daemon
// last acknowledged. The offset is the daemon's: the record advances to the reply's spooled
// decoded total, never by the slice sent. Each chunk carries the slice's base64, at most
// `ARTIFACT_CHUNK_MAX_BYTES` raw bytes, so memory stays bounded. A resent chunk (same
// sequence number, same bytes) is acknowledged without re-appending, so retry resumes.

import { ARTIFACT_CHUNK_MAX_BYTES } from "@ai-sidekicks/contracts/artifacts/ingest";

import { encodeBase64 } from "../base64.js";
import { type Clock } from "#renderer/lib/clock.js";
import {
  CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE,
  readChunkAcknowledgement,
} from "./attachment-ingest-acknowledgement.js";
import type { AttachmentIngestPort } from "./attachment-ingest-answer.js";
import { writeIngestRefusal, type AttachmentIngestEntries } from "../attachment-ingest-entries.js";
import { isSendingAttachmentIngestEntry } from "../shapes.js";

/** The refusal a payload that can no longer be read leaves on its entry. */
export const PAYLOAD_READ_REFUSAL_CODE = "payload-read-rejected";

/** What one chunk stream is given to send an open stream's bytes. */
export interface AttachmentChunkStreamOptions {
  readonly port: Pick<AttachmentIngestPort, "writeChunk">;
  readonly clock: Clock;
  readonly entries: AttachmentIngestEntries;
}

/** One open stream's bytes, sent in slices of at most one chunk cap. */
export class AttachmentChunkStream {
  readonly #port: Pick<AttachmentIngestPort, "writeChunk">;
  readonly #clock: Clock;
  readonly #entries: AttachmentIngestEntries;

  public constructor(options: AttachmentChunkStreamOptions) {
    this.#port = options.port;
    this.#clock = options.clock;
    this.#entries = options.entries;
  }

  /**
   * Send the stream's remaining bytes one slice at a time from the record's offset, resolving
   * `true` when all are acknowledged and `false` when the stream stopped.
   *
   * A resumed stream re-sends the slice that was in flight when a response was lost. The
   * sequence number is the offset divided by the cap, since every chunk but the last is exactly
   * one cap wide, so a resend recomputes the number the daemon's idempotent acknowledgement
   * matches on. An acknowledgement for another stream, without a total, or that fails to
   * advance is a refusal: a total that stood still would re-slice from the same offset forever.
   */
  public async send(localId: string): Promise<boolean> {
    for (;;) {
      const entry = this.#entries.current(localId);
      const stamp = this.#entries.stamp(localId);
      if (
        entry === undefined ||
        stamp === undefined ||
        // The bytes live on the sending arm only; an entry that settled underneath this
        // loop has released its payload.
        !isSendingAttachmentIngestEntry(entry) ||
        entry.ingestId === undefined
      ) {
        return false;
      }
      const ingestId = entry.ingestId;
      const payload = entry.payload;
      const offset = entry.receivedBytes;
      if (payload.size - offset <= 0) {
        return true;
      }
      const slice = payload.slice(offset, offset + ARTIFACT_CHUNK_MAX_BYTES);
      // The one local failure: a picker's `Blob` points at a file on disk, and one moved,
      // deleted or made unreadable between chunks rejects `arrayBuffer()`. Left alone, the
      // upload would sit at `ingesting` with the file gone.
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await slice.arrayBuffer());
      } catch {
        const unreadable = this.#entries.currentIfUnchanged(localId, stamp);
        if (unreadable !== undefined) {
          writeIngestRefusal(this.#entries, localId, unreadable, {
            code: PAYLOAD_READ_REFUSAL_CODE,
            detail: "The file could not be read.",
          });
        }
        return false;
      }
      if (this.#entries.currentIfUnchanged(localId, stamp) === undefined) {
        return false;
      }
      const acknowledged = await this.#port.writeChunk({
        ingestId,
        sequenceNumber: Math.floor(offset / ARTIFACT_CHUNK_MAX_BYTES),
        chunk: encodeBase64(bytes),
      });
      const settled = this.#entries.currentIfUnchanged(localId, stamp);
      if (settled === undefined) {
        // Abandoned or removed mid-chunk; `abandon` already asked for this spool back.
        return false;
      }
      const acknowledgement = readChunkAcknowledgement(settled, ingestId, acknowledged);
      if (acknowledgement.status === "unusable") {
        // `restart` is passed rather than the retry-in-place default, which assumes client
        // and daemon still agree on the offset.
        writeIngestRefusal(
          this.#entries,
          localId,
          settled,
          { code: CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE, detail: acknowledgement.detail },
          "restart",
        );
        return false;
      }
      this.#entries.write(localId, {
        ...settled,
        receivedBytes: acknowledgement.receivedBytes,
        lastProgressAtMilliseconds: this.#clock.now(),
      });
    }
  }
}
