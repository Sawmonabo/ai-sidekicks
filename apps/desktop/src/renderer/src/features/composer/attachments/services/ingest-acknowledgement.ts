// What one chunk acknowledgement establishes, and what it refuses to establish. The reply is
// `{ ingestId, receivedBytes }` where `receivedBytes` is the spooled running total of decoded
// bytes, so upload progress is the daemon's answer and never a count of what this client sent.
// A reply for another stream, or a total that did not advance, is unusable and stops the
// stream: a standing total would make the loop re-send the same chunk forever.

import { reportTripwire } from "#renderer/lib/tripwires/registry.js";
import type { AttachmentIngestEntry } from "../shapes.js";

/** Where this reading's tripwire reports from, so a firing names a module. */
export const ATTACHMENT_ACKNOWLEDGEMENT_SITE =
  "features/composer/attachments/services/ingest-acknowledgement.ts";

/**
 * Why the console stopped an ingest on the strength of the daemon's own reply. It is the
 * console's code, not a daemon one, and is classified `restart` by the caller because the
 * retry-in-place default assumes a shared offset.
 */
export const CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE = "chunk-acknowledgement-unusable";

/** The daemon's reply to one chunk, as this leg reads it. */
export interface ChunkAcknowledgement {
  readonly ingestId: string;
  readonly receivedBytes: number;
}

/** What one acknowledgement leaves the record able to say. */
export type ChunkAcknowledgementReading =
  | { readonly status: "acknowledged"; readonly receivedBytes: number }
  | { readonly status: "unusable"; readonly detail: string };

/**
 * Read one chunk acknowledgement against the stream it was for. A decoded total past the
 * declared size means a base64 length was charted, so it fires the `wire-figure-formatting`
 * tripwire and clamps the figure to the declared size. Pure, so every arm is testable directly.
 */
export function readChunkAcknowledgement(
  entry: AttachmentIngestEntry,
  sentIngestId: string,
  acknowledgement: ChunkAcknowledgement,
): ChunkAcknowledgementReading {
  if (acknowledgement.ingestId !== sentIngestId) {
    return {
      status: "unusable",
      detail:
        "The background service acknowledged " +
        `${String(acknowledgement.ingestId)} for a chunk sent on ` +
        `${sentIngestId}, so the reply belongs to another upload.`,
    };
  }
  const { receivedBytes } = acknowledgement;
  if (!Number.isFinite(receivedBytes) || receivedBytes <= entry.receivedBytes) {
    return {
      status: "unusable",
      detail:
        `The background service acknowledged ${String(receivedBytes)} ` +
        `spooled bytes on ${sentIngestId} after this client had already ` +
        `sent ${String(entry.receivedBytes)}, so the stream's offset is ` +
        "no longer shared.",
    };
  }
  if (receivedBytes > entry.declared.byteLength) {
    reportTripwire(
      "wire-figure-formatting",
      ATTACHMENT_ACKNOWLEDGEMENT_SITE,
      `ingest progress for ${entry.declared.localId} was acknowledged ` +
        `at ${String(receivedBytes)} decoded bytes past a declared total ` +
        `of ${String(entry.declared.byteLength)}; a progress figure ` +
        "counts decoded bytes and never an encoded length",
    );
    return { status: "acknowledged", receivedBytes: entry.declared.byteLength };
  }
  return { status: "acknowledged", receivedBytes };
}
