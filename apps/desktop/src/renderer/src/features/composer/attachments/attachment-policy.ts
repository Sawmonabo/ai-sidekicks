// What the daemon's two ingest refusals mean for the next act, and the sentence each
// puts in front of the control that acts on it.
//
// THE SEAM, IN ONE SENTENCE: this module changes when the daemon's ingest refusals
// change, and for no other reason. The codes are the contract's `ArtifactRefusalCode`
// values, and the staging limits, the default allow-list and the unresolved causes are
// the contract's too (`session-draft.ts`); the console chooses none of them. So nothing
// here reads an entry, renders a figure, or knows that a `Blob` exists, and this module
// imports nothing from the other attachment modules.
//
// IT DOES HOLD THE COPY, and that is deliberate rather than a leak of presentation. A
// disposition and the sentence in front of the control that acts on it are two halves of
// one seam: the disposition is only meaningful as the act it recommends, and separating
// them would let a code's classification and its explanation drift apart in two files.

import type { ArtifactRefusalCode } from "@ai-sidekicks/contracts";

/**
 * What a refusal means for the NEXT act, which is the only thing a user can use.
 *
 * Every call of the ingest trio is retry-safe — a replayed chunk is acknowledged
 * without re-appending, and a replayed completion
 * replays its original response verbatim — so a lost response is retried in place and
 * never restarted. The two named codes are the exceptions and they are deliberately
 * distinct: `artifact.ingest_stream_invalid` (409) is terminal for the stream and means
 * begin again, `artifact.ingest_capacity_exhausted` (429) is transient with no stream
 * state created and means wait and retry. Collapsing them would tell a user to
 * re-upload a hundred megabytes because the daemon was momentarily busy.
 */
export const INGEST_REFUSAL_DISPOSITIONS = ["retry-in-place", "wait-and-retry", "restart"] as const;

/** One disposition. Derived. */
export type IngestRefusalDisposition = (typeof INGEST_REFUSAL_DISPOSITIONS)[number];

/**
 * The two daemon codes whose disposition differs from the retry-safe default, typed by
 * the contract's refusal codes so a renamed code fails to compile here. A code the
 * console does not recognize takes the retry-in-place arm, which is the contract's own
 * default rather than a guess.
 */
export const INGEST_STREAM_INVALID_CODE: ArtifactRefusalCode = "artifact.ingest_stream_invalid";
export const INGEST_CAPACITY_EXHAUSTED_CODE: ArtifactRefusalCode =
  "artifact.ingest_capacity_exhausted";

/** What a user should do next about this refusal. Total over every code. */
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
