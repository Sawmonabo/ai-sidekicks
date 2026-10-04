// What the daemon's ingest refusals mean for the next act, and the sentence put in front of the
// control that acts on it. The codes, staging limits and allow-list are the contract's. The copy
// lives here beside the disposition so a code's classification and its explanation cannot drift
// apart. Imports nothing from the other attachment modules.

import type { ArtifactRefusalCode } from "@ai-sidekicks/contracts/artifacts/operations";

/**
 * What a refusal means for the next act. Every ingest call is retry-safe (a replayed chunk or
 * completion is answered without re-appending), so a lost response is retried in place. Two codes
 * differ: `artifact.ingest_stream_invalid` (409) is terminal, so begin again;
 * `artifact.ingest_capacity_exhausted` (429) is transient with no stream state, so wait and retry.
 * Collapsing them would tell a user to re-upload a hundred megabytes because the daemon was busy.
 */
export const INGEST_REFUSAL_DISPOSITIONS = ["retry-in-place", "wait-and-retry", "restart"] as const;

/** One disposition. */
export type IngestRefusalDisposition = (typeof INGEST_REFUSAL_DISPOSITIONS)[number];

/** The daemon code for an invalid ingest stream, which takes restart. */
export const INGEST_STREAM_INVALID_CODE: ArtifactRefusalCode = "artifact.ingest_stream_invalid";
/** The daemon code for a full ingest capacity, which takes wait-and-retry. */
export const INGEST_CAPACITY_EXHAUSTED_CODE: ArtifactRefusalCode =
  "artifact.ingest_capacity_exhausted";

/** What a user should do next about this refusal. An unrecognized code takes retry-in-place. */
export function ingestRefusalDisposition(code: string): IngestRefusalDisposition {
  if (code === INGEST_STREAM_INVALID_CODE) {
    return "restart";
  }
  if (code === INGEST_CAPACITY_EXHAUSTED_CODE) {
    return "wait-and-retry";
  }
  return "retry-in-place";
}

/** The sentence each disposition puts in front of the control that acts on it. */
export const INGEST_DISPOSITION_COPY: Readonly<Record<IngestRefusalDisposition, string>> = {
  "retry-in-place":
    "Retrying sends the same chunk again. A chunk the background service already has is acknowledged without being appended twice, so nothing is uploaded a second time.",
  "wait-and-retry":
    "The background service is at capacity and created no stream state. Waiting and retrying is the whole remedy; the bytes already sent are unaffected.",
  restart:
    "This stream is over and cannot be resumed. Retrying begins the upload again from the first byte.",
};

/** What canceling actually does, said exactly rather than as "canceled". */
export const INGEST_ABANDON_COPY =
  "Sending stops now. The bytes already spooled are cleaned up shortly by the background service rather than instantly, and no artifact is minted.";
