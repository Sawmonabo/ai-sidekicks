// What the DAEMON decided about an attachment, transcribed and nothing else.
//
// THE SEAM, IN ONE SENTENCE: this module changes when `Spec-014` changes, and for no
// other reason. The allow-list, the two named refusal codes, what each refusal means
// for the next act, and the six causes an attachment can be unresolved for are all the
// daemon's vocabulary — the console chooses none of them. So nothing here reads an
// entry, renders a figure, or knows that a `Blob` exists, and this module imports
// nothing from its own family. It is the leaf the other three attachment modules rest
// on, which is what keeps a contract change from touching a card.
//
// IT DOES HOLD THE COPY, and that is deliberate rather than a leak of presentation. A
// disposition and the sentence in front of the control that acts on it are two halves of
// one seam: the disposition is only meaningful as the act it recommends, and separating
// them would let a code's classification and its explanation drift apart in two files.
//
// WHAT THIS MODULE REFUSES TO MODEL:
//   • No client-side type gate. The allow-list below is a HINT for the picker and the
//     default stated where the effective list cannot be read; a hard block here would
//     make the console wrong about an operator-widened deployment it cannot see.

// --- The default allow-list ----------------------------------------------
//
// `Spec-014 §Bounds (normative defaults; operator-tunable)` ships this value-for-value,
// and an operator override REPLACES it wholesale with no merge semantics — so the hint is this list or the operator's, never
// this list plus a set of edits. `image/svg+xml` is deliberately absent: it is the one
// image type that is also a scriptable document, and its exclusion is a recorded
// decision rather than an oversight.

/** Admitted on a UTF-8 well-formedness proof rather than a byte signature. */
export const ATTACHMENT_SIGNATURE_EXEMPT_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/yaml",
  "text/xml",
  "text/x-diff",
] as const;

/** Admitted on the payload's own leading signature. */
export const ATTACHMENT_SIGNATURE_VERIFIED_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/zip",
  "application/gzip",
] as const;

/** The whole shipped default, in the order the two subsets are stated. */
export const ATTACHMENT_ALLOWLIST_DEFAULT: readonly string[] = [
  ...ATTACHMENT_SIGNATURE_EXEMPT_MEDIA_TYPES,
  ...ATTACHMENT_SIGNATURE_VERIFIED_MEDIA_TYPES,
];

/**
 * What a refusal means for the NEXT act, which is the only thing a participant can use.
 *
 * `Spec-014 §Interfaces And Contracts` makes every call of the ingest trio retry-safe —
 * a replayed chunk is acknowledged without re-appending, and a replayed completion
 * replays its original response verbatim — so a lost response is retried in place and
 * never restarted. The two named codes are the exceptions and they are deliberately
 * distinct: `artifact.ingest_stream_invalid` (409) is terminal for the stream and means
 * begin again, `artifact.ingest_capacity_exhausted` (429) is transient with no stream
 * state created and means wait and retry. Collapsing them would tell a participant to
 * re-upload a hundred megabytes because the daemon was momentarily busy.
 */
export const INGEST_REFUSAL_DISPOSITIONS = ["retry-in-place", "wait-and-retry", "restart"] as const;

/** One disposition. Derived. */
export type IngestRefusalDisposition = (typeof INGEST_REFUSAL_DISPOSITIONS)[number];

/**
 * The two daemon codes whose disposition differs from the retry-safe default.
 *
 * Named here as strings because `packages/contracts` registers NEITHER — there is no
 * artifact error namespace in `error.ts` at all. They are `Spec-014`'s codes, matched
 * against whatever a refusal carries, and they are not method names, event types, or
 * wire fields: a code the console does not recognise takes the retry-in-place arm,
 * which is the contract's own default rather than a guess.
 */
export const INGEST_STREAM_INVALID_CODE = "artifact.ingest_stream_invalid";
export const INGEST_CAPACITY_EXHAUSTED_CODE = "artifact.ingest_capacity_exhausted";

/** What a participant should do next about this refusal. Total over every code. */
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
    "Retrying sends the same chunk again. A chunk the daemon already has is acknowledged without being appended twice, so nothing is uploaded a second time.",
  "wait-and-retry":
    "The daemon is at capacity and created no stream state. Waiting and retrying is the whole remedy; the bytes already sent are unaffected.",
  restart:
    "This stream is over and cannot be resumed. Retrying begins the upload again from the first byte.",
};

/** What cancelling actually does, said exactly rather than as "cancelled". */
export const INGEST_ABANDON_COPY =
  "Sending stops now. The bytes already spooled are cleaned up shortly by the daemon rather than instantly, and no artifact is minted.";

// --- The unresolved marker ------------------------------------------------

/**
 * Why an attachment could not be resolved where it sits. Closed at six.
 *
 * `Spec-014 §Fallback Behavior` requires the turn to PROCEED and the marker to sit in
 * the attachment's declared position — never appended, never footnoted — so this is a
 * per-position reading and not a page-level banner.
 */
export const UNRESOLVED_ATTACHMENT_CAUSES = [
  "deleted",
  "local_only_remote",
  "pending_replication",
  "over_cap",
  "quota_exceeded",
  "expired",
] as const;

/** One unresolved cause. Derived. */
export type UnresolvedAttachmentCause = (typeof UNRESOLVED_ATTACHMENT_CAUSES)[number];
