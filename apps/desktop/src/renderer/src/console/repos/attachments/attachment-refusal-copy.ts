// What each named ingest refusal MEANS on this surface, and what a participant does
// next about it.
//
// WHY THIS IS A TABLE OF THE ATTACHMENT FAMILY'S OWN AND NOT A ROW IN
// `core/refusal-remedies.ts`. That table fills rule 9's `action` slot with ONE sentence
// naming an act — "send the line again", "open it again from the session list" — for
// codes that reach several surfaces and need one answer between them. These four reach
// exactly one surface, and what each of them needs is not a next move but a MEANING the
// daemon's own sentence deliberately leaves out: which of three enforcement points
// answered, what survived a whole-carrier refusal, what happened to the bytes. That is
// this family's reading of `Spec-014`, it changes when that spec changes, and it sits
// beside `attachment-policy.ts`, which holds the same class of copy for the two
// disposition-bearing codes.
//
// NOTHING HERE PARAPHRASES A `detail`. Rule 9 puts the daemon's own sentence on screen
// unparaphrased and gives the console the slot beside it; every surface that renders
// one of these renders the code, the daemon's sentence, and then this. A code this
// table does not name renders exactly as it does without it.
//
// EVERY KEY IS A CODE `error-contracts.md` REGISTERS, and that is checked against the
// registry file rather than asserted here — a key nothing can send is copy that reaches
// nobody and nothing reports it. All four are `reserved` rows today, which is what
// `artifact.*` rows are until Plan-014's own legs land; reserved is registered.

/** The console's reading of one refusal, in the two halves rule 9 separates. */
export interface AttachmentRefusalCopy {
  /** What this refusal is ABOUT, where the code alone does not say. */
  readonly meaning: string;
  /** What a participant does next, or the honest statement that there is nothing. */
  readonly nextMove: string;
}

/**
 * The four ingest refusals whose meaning the code alone does not carry.
 *
 * The two codes that decide a RETRY DISPOSITION are deliberately absent:
 * `artifact.ingest_stream_invalid` and `artifact.ingest_capacity_exhausted` are
 * answered by `attachment-policy.ts`'s `INGEST_DISPOSITION_COPY`, because for those two
 * the meaning IS the disposition and splitting them across two tables would let a
 * code's classification and its explanation drift apart in two files.
 */
const ATTACHMENT_REFUSAL_COPY: Readonly<Record<string, AttachmentRefusalCopy>> = {
  // Three enforcement points, and the third is the one nobody expects: a chunk that
  // pushes the running decoded total past the size this stream DECLARED is refused
  // even when that declaration sits far below the deployment's cap, because the
  // declaration is the stream's own spool reservation.
  "artifact.too_large": {
    meaning:
      "Three checks can answer with this: the transport frame the chunk travelled in, the total this upload declared when it opened, and the running count of decoded bytes the daemon has spooled. The third refuses a chunk that pushes the running total past the declaration even far below the deployment's own bound, because the declared total is what reserved the spool.",
    nextMove:
      "The spool for this upload is gone. Attach a file inside the bound, or ask the operator what this deployment admits — the figure shown here is what the console ships with, and an override replaces it wholesale.",
  },
  // The carrier is refused WHOLE, at acceptance, before an element is bound or
  // delivered — and the artifacts earlier ingests already minted are untouched.
  "artifact.too_many_attachments": {
    meaning:
      "The whole carrier was refused at acceptance, before any attachment was bound or delivered, so nothing partial was left behind. Every artifact an earlier upload already minted is untouched and stays a session artifact you can reference again.",
    nextMove:
      "Take attachments off this turn until the carrier is inside the count, then send it. Nothing has to be uploaded a second time.",
  },
  // A type verdict on the DERIVED type. The bytes are quarantined rather than stored
  // under a type the daemon did not find.
  "artifact.unsupported_media_type": {
    meaning:
      "The daemon read the bytes and the type it derived is not on this deployment's allow-list — or it contradicts the type the upload declared. The payload is quarantined rather than stored, and it is never silently re-typed to something that would have been admitted.",
    nextMove:
      "Nothing about this file will make it through as it stands. Convert it to an admitted type and attach that, or ask the operator to widen the list.",
  },
  // A CONTENT verdict, not a type one, and never produced under the default
  // configuration — which is why saying so is the whole of the copy.
  "artifact.scanner_rejected": {
    meaning:
      "This is a content verdict from a scanner the operator configured, not a problem with the file's type: the type was allow-listed and reconciled before the scan ran. The bytes are quarantined. The shipped default configuration runs no scanner and never produces this.",
    nextMove:
      "The scanner's own verdict is the whole answer, and the console has nothing to add to it. Take it up with whoever configured the scan.",
  },
};

/** This surface's reading of one code, or nothing where the daemon's sentence is all of it. */
export function attachmentRefusalCopyFor(code: string): AttachmentRefusalCopy | undefined {
  return Object.hasOwn(ATTACHMENT_REFUSAL_COPY, code) ? ATTACHMENT_REFUSAL_COPY[code] : undefined;
}

/** Every code this table answers for, as a set a test can walk against the registry. */
export const ATTACHMENT_REFUSAL_COPY_CODES: readonly string[] =
  Object.keys(ATTACHMENT_REFUSAL_COPY);

/** The code a carrier past the count bound is refused with, named once. */
export const TOO_MANY_ATTACHMENTS_CODE = "artifact.too_many_attachments";

/** The code an over-sized payload is refused with, named once. */
export const TOO_LARGE_CODE = "artifact.too_large";
