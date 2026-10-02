// What one attachment chip says, folded from the entry the staged list published. Pure: it
// reads no clock and holds no state, and every reading comes from the attachment modules that
// own the ingest, so the chip and the transcript card cannot disagree about an upload.
// A refusal is the only non-neutral tone.

import { INGEST_ABANDON_COPY, INGEST_DISPOSITION_COPY } from "./attachment-policy.js";
import { isIngestStalled } from "./attachment-presentation.js";
import {
  ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL,
  attachmentMediaTypeReadings,
  attachmentNameReading,
} from "./attachment-provenance.js";
import type { AttachmentIngestEntry } from "./attachment-shapes.js";
import { formatByteQuantity } from "@renderer/lib/wire-figures.js";
import { type ChipTone } from "@renderer/components/Chip/Chip.js";

/** What one chip renders, and which acts it offers. */
export interface ComposerAttachmentChipModel {
  readonly localId: string;
  /** The name this entry goes by: `fileName` once the daemon has minted one. */
  readonly name: string;
  /** True while the name is still the caller's own claim rather than the manifest's. */
  readonly nameIsDeclared: boolean;
  /** The leading media-type reading, or `undefined` where neither side has one. */
  readonly mediaType: string | undefined;
  /** Present only where the leading reading is the caller's claim, so the chip can say so. */
  readonly mediaTypeQualifier: string | undefined;
  /** The size a person reads, from the chokepoint formatter and nowhere else. */
  readonly sizeText: string;
  /** The raw byte count behind {@link sizeText}, for the element's own title. */
  readonly sizeTitle: string;
  readonly state: AttachmentIngestEntry["state"];
  readonly tone: ChipTone;
  /**
   * Spooled bytes over declared bytes, 0 to 1, while an upload is in flight. Absent on every
   * settled state: a bar drawn at zero for a refused upload reads as one about to start.
   */
  readonly progressFraction: number | undefined;
  /** True where this upload has gone quiet long enough to say so. */
  readonly isStalled: boolean;
  /** The daemon's refusal, verbatim, with what it recommends doing next. */
  readonly refusal: ComposerAttachmentRefusal | undefined;
  /** Whether a retry may be offered. False for every settled entry, refused excepted. */
  readonly offersRetry: boolean;
  /** Whether an abandon may be offered. */
  readonly offersAbandon: boolean;
  /** What abandoning actually does, for the control that offers it. */
  readonly abandonCopy: string;
}

/** One refused ingest, as the chip renders it. */
export interface ComposerAttachmentRefusal {
  readonly code: string;
  readonly detail: string;
  /** What this refusal's disposition recommends. Absent where none was classified. */
  readonly disposition: string | undefined;
}

/** Fold one published entry into the line a chip renders. Total over every state. */
export function composerAttachmentChip(
  entry: AttachmentIngestEntry,
  publishedAtMilliseconds: number,
): ComposerAttachmentChipModel {
  const nameReading = attachmentNameReading(entry);
  const [leadingMediaType] = attachmentMediaTypeReadings(entry);
  // The derived length once one exists; a chip still showing the claim would report the
  // caller's word as the manifest's.
  const byteLength = entry.derived?.sizeBytes ?? entry.declared.byteLength;
  const sizeFigure = formatByteQuantity(byteLength);
  return {
    localId: entry.declared.localId,
    name: nameReading.name,
    nameIsDeclared: nameReading.provenance === "declared",
    mediaType: leadingMediaType?.mediaType,
    mediaTypeQualifier:
      leadingMediaType?.provenance === "declared"
        ? ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL
        : undefined,
    sizeText: sizeFigure.text,
    sizeTitle: String(byteLength),
    state: entry.state,
    tone: entry.state === "refused" ? "failure" : "neutral",
    progressFraction: ingestProgressFraction(entry),
    isStalled: isIngestStalled(entry, publishedAtMilliseconds),
    refusal:
      entry.refusal === undefined
        ? undefined
        : {
            code: entry.refusal.code,
            detail: entry.refusal.detail,
            disposition:
              entry.disposition === undefined
                ? undefined
                : INGEST_DISPOSITION_COPY[entry.disposition],
          },
    offersRetry: entry.state === "refused",
    offersAbandon: entry.state === "declared" || entry.state === "ingesting",
    abandonCopy: INGEST_ABANDON_COPY,
  };
}

/**
 * How far along an in-flight upload is, or `undefined` where there is nothing to show. A
 * zero-length declaration answers `undefined` rather than dividing by it.
 */
function ingestProgressFraction(entry: AttachmentIngestEntry): number | undefined {
  if (entry.state !== "ingesting" || entry.declared.byteLength === 0) {
    return undefined;
  }
  return Math.min(1, entry.receivedBytes / entry.declared.byteLength);
}
