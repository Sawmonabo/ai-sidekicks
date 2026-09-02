// What the ONE ingest pipeline has done with a browser-produced object.
//
// `Spec-023 §Console Design (Meridian)` 12.6: capture bytes, download bytes, and a
// bundled asset set all enter through `AttachmentIngestInit` / `AttachmentIngestChunk`
// / `AttachmentIngestComplete` and run the ordered gate sequence of
// `Spec-014 §Ingest Validation And Payload Bounds (V1)` before anything persists.
// "There is no second validation path for browser bytes, which is the point of that
// section's one-pipeline rule."
//
// So there is no second STATE vocabulary either. A capture card and a download card
// render different nouns — a scope and a media type on one, a source page and a
// declared total on the other — but the thing that happened to their bytes is one
// fact with one shape, and two copies of that shape drift the moment one card grows
// an arm the other does not.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT HOLD. The refusal CODES. 12.6 enumerates
// five of them, and every one is the daemon's to send: a card renders whatever
// `ConsoleRefusal` it is handed, verbatim, and never checks the code against a list
// of its own. A console-side enumeration would be a second source of truth for a
// classification the pipeline owns, and it would go stale the first time the ingest
// gates grow a sixth answer.
//
// The `remedy` below is the one thing that is NOT derivable from a code the console
// refuses to read, and it is therefore an input: the producer says whether the bytes
// can be sent again later, whether the stream has to restart, or whether this object
// is simply not going to be stored. 12.6's degraded state — "ingest capacity
// exhausted, the row says retry later and the bytes are not lost from the download" —
// is that first arm, and the console is told it rather than inferring it.

import type { ConsoleRefusal } from "../core/index.js";
import { formatByteQuantity } from "../primitives/index.js";

/**
 * What the operator can do about a refused ingest. Closed, and closed at three
 * because a fourth answer is a fourth thing to render rather than a shade of one of
 * these.
 *
 * Declared as a tuple with the union derived from it, so a widening is one edit and
 * every consumer that switches over it stops compiling until it handles the arm.
 */
export const BROWSER_INGEST_REMEDIES = ["retry-later", "restart-upload", "none"] as const;

export type BrowserIngestRemedy = (typeof BROWSER_INGEST_REMEDIES)[number];

/**
 * One produced object's position in the pipeline.
 *
 * `in-flight` carries both figures because 12.6 requires the row to show received
 * bytes AGAINST the declared total — a percentage alone hides which of the two
 * numbers a stalled upload is stuck on.
 *
 * `stored` carries the artifact's id rather than a path. 12.6: "Reveal in file
 * manager takes no path from the renderer"; the id is what a later fetch is keyed
 * by, and it is the only locator that crosses this boundary in either direction.
 */
export type BrowserIngestState =
  | {
      readonly status: "in-flight";
      readonly receivedByteLength: number;
      readonly declaredByteLength: number;
    }
  | { readonly status: "stored"; readonly artifactId: string; readonly byteLength: number }
  | {
      readonly status: "refused";
      readonly refusal: ConsoleRefusal;
      readonly remedy: BrowserIngestRemedy;
    }
  // Nobody has asked yet. Distinct from an empty in-flight reading, which would
  // claim a transfer began, and from `refused`, which would claim one failed —
  // the `not-checked` fact of `Spec-023 §Console Design (Meridian)` rule 8 as a
  // state rather than as a rendering.
  | { readonly status: "not-checked" };

/**
 * Whether these two figures form a range at all.
 *
 * ONE PREDICATE FOR EVERY READING OF THE METER. The fill, the sentence under it, and
 * the value pair assistive technology reads are three renderings of the same
 * question, and each answering it its own way is how a bar reset to empty came to
 * carry `aria-valuenow` past its own `aria-valuemax` — an invalid determinate range,
 * announced as a position on a scale that does not exist.
 *
 * A denominator has to be finite and positive to divide by, and a numerator has to
 * be finite to place. Nothing here is about how far along the transfer is: a
 * received figure of zero is a perfectly good reading of a range that is known.
 */
export function isIngestRangeDeterminate(
  receivedByteLength: number,
  declaredByteLength: number,
): boolean {
  return (
    Number.isFinite(receivedByteLength) &&
    Number.isFinite(declaredByteLength) &&
    declaredByteLength > 0
  );
}

/**
 * The sentence the ingest meter is read against: what arrived, of what was declared.
 *
 * One implementation for both cards, and it performs no arithmetic of its own — both
 * figures go through the console's single formatting chokepoint and are joined. A
 * card that composed this itself would be two call sites deciding independently
 * whether the separator is a slash, the word "of", or an em dash.
 *
 * An indeterminate range says so in words rather than printing the total it was
 * handed. "512 KiB of 0 B" is not a smaller reading of the same fact — it is a claim
 * that the producer declared nothing at all, rendered as a claim that it declared
 * zero, beside a bar this same predicate has already reset to empty.
 */
export function formatIngestProgress(
  receivedByteLength: number,
  declaredByteLength: number,
  locale?: string,
): string {
  const received = formatByteQuantity(receivedByteLength, locale).text;
  if (!isIngestRangeDeterminate(receivedByteLength, declaredByteLength)) {
    return `${received} of an undeclared total`;
  }
  const declared = formatByteQuantity(declaredByteLength, locale).text;
  return `${received} of ${declared}`;
}

/**
 * How far along the meter's fill sits, as a CSS width.
 *
 * A ratio is not a byte figure — it names no unit and nothing about it is scaled —
 * so it is composed here rather than in the figure chokepoint, which formats values
 * a reader sees. A declared total of zero (or a nonsense one) renders an empty bar
 * rather than a full one: an unknown denominator is not completion.
 */
export function ingestFillWidth(
  receivedByteLength: number,
  declaredByteLength: number,
): `${number}%` {
  if (!isIngestRangeDeterminate(receivedByteLength, declaredByteLength)) {
    return "0%";
  }
  if (receivedByteLength <= 0) {
    return "0%";
  }
  const ratio = Math.min(1, receivedByteLength / declaredByteLength);
  return `${Math.round(ratio * 100)}%`;
}

/**
 * The operator's next move on a refused ingest, in one sentence.
 *
 * A table rather than a `switch` at each card, and here rather than in either card,
 * because both render the same three sentences and 12.6 fixes one of them in terms:
 * on capacity exhaustion "the row says retry later and the bytes are not lost from
 * the download". Two copies of that sentence is two places for it to stop matching
 * what the pipeline actually did.
 *
 * Total over `BrowserIngestRemedy` by construction — a fourth remedy fails to
 * compile here before it can reach a row that renders nothing beside a refusal.
 */
const INGEST_REMEDY_SENTENCES: Readonly<Record<BrowserIngestRemedy, string>> = {
  "retry-later": "The bytes are not lost — retry later.",
  "restart-upload": "Restart the upload.",
  none: "These bytes will not be stored.",
};

/** What to do about a refused ingest. The console's own reading, never the wire's. */
export function ingestRemedySentence(remedy: BrowserIngestRemedy): string {
  return INGEST_REMEDY_SENTENCES[remedy];
}
