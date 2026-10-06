// Which readings a card is given about an attachment, and whose each one is. Neither side gates
// the other: the media type can show both readings, while the derived name replaces the
// declaration outright. This is the only place the declared-versus-derived precedence is decided.
// It stores and formats nothing.

import type { AttachmentIngestEntry } from "./shapes.js";

/**
 * Whose reading of a value this is. A declaration is advisory input that narrows an expected
 * signature and never widens acceptance; a derived value is what the daemon found in the bytes.
 * The card labels a declared one as declared so a claim cannot pass for a finding.
 */
export type AttachmentProvenance = "derived" | "declared";

/** One media-type reading, and whose it is. */
export interface AttachmentMediaTypeReading {
  readonly mediaType: string;
  readonly provenance: AttachmentProvenance;
}

/**
 * Which media-type readings an in-flight attachment has, in display order. Either value alone
 * is shown: a paste has no `File.type`, yet still shows the derived type. Where both exist and
 * agree there is one chip; where they differ the derived one leads and the declaration survives
 * beside it, since a disagreement is a fact a user acts on.
 */
export function attachmentMediaTypeReadings(
  entry: AttachmentIngestEntry,
): readonly AttachmentMediaTypeReading[] {
  const declared = entry.declared.declaredMediaType;
  const derived = entry.derived?.mimeType;
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

/** One name reading, and whose it is. */
export interface AttachmentNameReading {
  readonly name: string;
  readonly provenance: AttachmentProvenance;
}

/**
 * Which name an in-flight attachment goes by. The derived name replaces the declaration
 * outright, since ingest validation keeps caller strings out of paths and keeps the original
 * as metadata only. One function serves the face and the accessible label so a screen-reader
 * user hears the same name a sighted one sees, even where normalization changed it.
 */
export function attachmentNameReading(entry: AttachmentIngestEntry): AttachmentNameReading {
  const derived = entry.derived?.fileName;
  return derived === undefined
    ? { name: entry.declared.declaredName, provenance: "declared" }
    : { name: derived, provenance: "derived" };
}
