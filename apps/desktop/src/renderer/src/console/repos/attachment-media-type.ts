// Which media-type readings a card is given, and whose each one is.
//
// THE SEAM, IN ONE SENTENCE: this module changes when the rule about the two readings
// changes, and that rule is small enough and load-bearing enough to be findable on its
// own. It was four declarations in the middle of the model this family has since split
// apart, where the one thing a reader needed — that NEITHER side gates the other — read
// as a detail of a shape file rather than as the decision it is.
//
// It takes an entry and returns readings. It stores nothing, formats nothing, and is
// the only place the declared-versus-derived precedence is decided.

import type { AttachmentIngestEntry } from "./attachment-shapes.js";

/**
 * Whose reading of the media type this is.
 *
 * The card labels the declared one AS declared, because the two are not the same
 * class of claim: `Spec-014 §Required Behavior` makes the declaration advisory input
 * that narrows an expected signature and never widens acceptance, while the derived
 * type is what the daemon found in the bytes. A chip that showed one and meant the
 * other would let a caller's claim pass for a finding.
 */
export type AttachmentMediaTypeProvenance = "derived" | "declared";

/** One media-type reading, and whose it is. */
export interface AttachmentMediaTypeReading {
  readonly mediaType: string;
  readonly provenance: AttachmentMediaTypeProvenance;
}

/**
 * Which media-type readings an in-flight attachment has, in the order they are shown.
 *
 * NEITHER SIDE GATES THE OTHER, which is the whole point of this function. The card
 * used to test the DECLARATION alone, so a payload a browser handed over with no
 * `File.type` — every paste, and any client that omits it — hid the derived type the
 * daemon had already found, on exactly the PNG and PDF attachments where the derived
 * signature is the interesting fact. Either value alone is a reading and is shown.
 *
 * WHERE BOTH EXIST AND AGREE, ONE CHIP. The declaration was confirmed rather than
 * contradicted, and printing the same string twice would read as a disagreement.
 *
 * WHERE BOTH EXIST AND DIFFER, THE DERIVED ONE LEADS AND THE DECLARATION SURVIVES
 * BESIDE IT. The derived type is the authority — `AttachmentCard.tsx`'s own rule that
 * derived truth REPLACES the declaration — but a disagreement is a fact a participant
 * acts on, and dropping the declaration would hide that their client claimed something
 * else.
 */
export function attachmentMediaTypeReadings(
  entry: AttachmentIngestEntry,
): readonly AttachmentMediaTypeReading[] {
  const declared = entry.declared.declaredMediaType;
  const derived = entry.derived?.derivedMediaType;
  if (derived === undefined) {
    return declared === undefined ? [] : [{ mediaType: declared, provenance: "declared" }];
  }
  const derivedReading: AttachmentMediaTypeReading = {
    mediaType: derived,
    provenance: "derived",
  };
  if (declared === undefined || declared === derived) {
    return [derivedReading];
  }
  return [derivedReading, { mediaType: declared, provenance: "declared" }];
}

/** What the card calls the caller's own claim, where it is shown beside a finding. */
export const ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL = "declared";
