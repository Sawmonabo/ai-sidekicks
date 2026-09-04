// What one chunk acknowledgement establishes, and what it refuses to establish.
//
// THE SEAM, IN ONE SENTENCE: this module changes when the daemon's answer to a chunk
// changes. `docs/architecture/contracts/api-payload-contracts.md §Plan-014 — Artifacts
// Files And Attachments` registers `AttachmentIngestChunkResponse` as `{ ingestId,
// receivedBytes }` — the second of those being "spooled running total of DECODED bytes
// after this chunk", which the same line names as the enforced byte bound — so the
// answer to "how far is this upload" is the daemon's and never this console's.
//
// WHY THE LEDGER MAY NOT ADVANCE BY WHAT IT SENT. The chunk loop used to add the local
// slice length to its own running total and never read the reply at all, which made the
// progress figure a record of what this client PUT ON THE WIRE rather than of what the
// daemon SPOOLED. Those are different numbers the moment anything is dropped, replayed,
// or refused past the point the client noticed — and the client could not have told,
// because it was never looking. The acknowledgement also names the stream, so a reply
// belonging to another ingest is detectable rather than charged to whichever upload
// happened to be awaiting one.
//
// AND AN UNUSABLE ACKNOWLEDGEMENT STOPS THE STREAM RATHER THAN BEING ROUNDED OFF. Three
// answers are unusable, and each of them means the byte accounting the rest of this
// protocol rests on has stopped being shared:
//
//   • NO ACKNOWLEDGEMENT AT ALL. A served answer carrying no value is a reply this leg
//     cannot read a total off, and the declared type does not make it impossible — the
//     live port is one process boundary away.
//   • A DIFFERENT STREAM. Charging another ingest's total to this one would move this
//     upload's progress by an amount that has nothing to do with it.
//   • A TOTAL THAT DID NOT ADVANCE. Every chunk this loop sends carries at least one
//     byte, so a lawful running total after it is strictly greater than the one before.
//     A total that regressed contradicts the reply that preceded it, and one that stood
//     still would leave the loop re-slicing from the same offset for as long as the
//     daemon kept answering — the ledger IS the offset, so a client that accepted a
//     standing total would send the same chunk forever. Refusing is what makes the loop
//     terminate on the daemon's own answer rather than on this client's optimism.
//
// The clamp below is the one arm that is not a refusal, and it is the rule this family
// has always enforced: never chart a base64 length as progress. An encoded length is
// about four thirds of the decoded one, so a total charted from one drives past a bound
// the caller itself declared — impossible for a decoded count, and therefore the
// observable signature of having charted the wrong number. It fires the
// `wire-figure-formatting` tripwire and the figure is clamped, so the bar cannot render
// past full while the defect is reported.

import { reportTripwire } from "../core/index.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";

/** Where this reading's tripwire reports from, so a firing names a module. */
export const ATTACHMENT_ACKNOWLEDGEMENT_SITE = "repos/attachment-ingest-acknowledgement.ts";

/**
 * Why the console stopped an ingest on the strength of the daemon's own reply.
 *
 * The console's code and not a daemon one: `Spec-014`'s vocabulary describes what the
 * daemon decided, and this is a finding about an answer that cannot be reconciled with
 * what this client sent. It is classified `restart` by the caller rather than mapped
 * through `ingestRefusalDisposition`, because the retry-in-place default assumes a
 * shared offset and that is exactly what has stopped being true.
 */
export const CHUNK_ACKNOWLEDGEMENT_UNUSABLE_CODE = "chunk-acknowledgement-unusable";

/** The registered `AttachmentIngestChunkResponse`, as this leg reads it. */
export interface ChunkAcknowledgement {
  readonly ingestId: string;
  readonly receivedBytes: number;
}

/** What one acknowledgement leaves the ledger able to say. */
export type ChunkAcknowledgementReading =
  | { readonly status: "acknowledged"; readonly receivedBytes: number }
  | { readonly status: "unusable"; readonly detail: string };

/**
 * Read one chunk acknowledgement against the stream it was supposed to be for.
 *
 * Pure, exported, and taking the entry beside the id this client sent, so every arm is
 * provable by driving THIS function rather than by reaching into the protocol class or
 * standing in for one.
 */
export function readChunkAcknowledgement(
  entry: AttachmentIngestEntry,
  sentIngestId: string,
  acknowledgement: ChunkAcknowledgement | undefined,
): ChunkAcknowledgementReading {
  if (acknowledgement === undefined) {
    return {
      status: "unusable",
      detail: `The daemon answered the chunk for ${sentIngestId} without saying how many bytes it has spooled, so this upload's progress is unknown.`,
    };
  }
  if (acknowledgement.ingestId !== sentIngestId) {
    return {
      status: "unusable",
      detail: `The daemon acknowledged ${String(acknowledgement.ingestId)} for a chunk sent on ${sentIngestId}, so the reply belongs to another upload.`,
    };
  }
  const { receivedBytes } = acknowledgement;
  if (!Number.isFinite(receivedBytes) || receivedBytes <= entry.receivedBytes) {
    return {
      status: "unusable",
      detail: `The daemon acknowledged ${String(receivedBytes)} spooled bytes on ${sentIngestId} after this client had already sent ${String(entry.receivedBytes)}, so the stream's offset is no longer shared.`,
    };
  }
  if (receivedBytes > entry.declared.byteLength) {
    reportTripwire(
      "wire-figure-formatting",
      ATTACHMENT_ACKNOWLEDGEMENT_SITE,
      `ingest progress for ${entry.declared.localId} was acknowledged at ${String(receivedBytes)} decoded bytes past a declared total of ${String(entry.declared.byteLength)}; a progress figure counts decoded bytes and never an encoded length`,
    );
    return { status: "acknowledged", receivedBytes: entry.declared.byteLength };
  }
  return { status: "acknowledged", receivedBytes };
}
