// What one attachment chip says, folded from the entry the carrier published.
//
// A FOLD AND NOT A COMPONENT, so the sentence a chip carries is drivable from a test
// with no DOM and the render below it is a render. Everything here is derived from one
// entry plus the instant that entry was published at; nothing reads a clock, calls a
// wire, or holds state.
//
// EVERY READING COMES FROM THE FAMILY THAT OWNS THE INGEST. The name an entry goes by,
// which media-type readings it has, what cancelling does, and what a refusal recommends
// are all `console/repos/` answers taken through its door — this module composes them
// into one line and answers none of them itself. The composer and the artifact pane
// therefore cannot disagree about an upload: one says it as a card and one as a chip,
// from one set of readings.
//
// THE TONE IS THE TWO-HUE RULE AND NOT A PALETTE. A refusal is red because something
// failed; everything else is neutral, including an upload in flight, which needs nobody.
// An entry past the byte bound is deliberately NOT amber: the bound is the daemon's and
// the upload is still attempted, so a colour there would report a verdict the console
// has not been given.

import {
  ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL,
  INGEST_ABANDON_COPY,
  INGEST_DISPOSITION_COPY,
  SHIPPED_DEFAULT_ALLOWLIST,
  attachmentMediaTypeReadings,
  attachmentNameReading,
  exceedsAttachmentByteAllowance,
  isIngestStalled,
  type AttachmentIngestEntry,
} from "../../../../console/repos/index.js";
import { formatByteQuantity, type ChipTone } from "../../../../console/primitives/index.js";

/** What one chip renders, and which acts it offers. */
export interface ComposerAttachmentChipModel {
  readonly localId: string;
  /** The name this entry goes by — `normalizedName` once the daemon has minted one. */
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
   * Spooled bytes over declared bytes, 0 to 1, while an upload is in flight.
   *
   * Absent on every settled state, which is the difference between "no progress yet"
   * and "no progress to show": a bar drawn at zero for a refused upload reads as an
   * upload that is about to start.
   */
  readonly progressFraction: number | undefined;
  /** True where this upload has gone quiet long enough to say so. */
  readonly isStalled: boolean;
  /** True where the payload's own length is past the per-attachment bound. */
  readonly isPastByteAllowance: boolean;
  /** The daemon's refusal, verbatim, with what it recommends doing next. */
  readonly refusal: ComposerAttachmentRefusal | undefined;
  /** Whether a retry may be offered. False for every settled entry, refused excepted. */
  readonly offersRetry: boolean;
  /** Whether an abandon may be offered, and the sentence that says what it does. */
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

/**
 * Fold one published entry into the line a chip renders.
 *
 * Total over every state: there is no entry this returns nothing for, because a chip
 * that vanished on a state nobody had thought about would drop an attachment from the
 * carrier without saying so.
 */
export function composerAttachmentChip(
  entry: AttachmentIngestEntry,
  publishedAtMilliseconds: number,
): ComposerAttachmentChipModel {
  const nameReading = attachmentNameReading(entry);
  const [leadingMediaType] = attachmentMediaTypeReadings(entry);
  // The DERIVED length once one exists, because that is what the daemon found; the
  // declaration is what it was before, and a chip that kept showing the claim after a
  // finding arrived would report the caller's word as the manifest's.
  const byteLength = entry.derived?.derivedSizeBytes ?? entry.declared.byteLength;
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
    isPastByteAllowance: exceedsAttachmentByteAllowance(
      entry.declared.byteLength,
      SHIPPED_DEFAULT_ALLOWLIST.maximumByteLength,
    ),
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
 * How far along an in-flight upload is, or `undefined` where there is nothing to show.
 *
 * The SPOOLED count over the DECLARED one, which are the two numbers the protocol
 * actually carries: `receivedBytes` is the daemon's acknowledgement and the declaration
 * is the reservation it was admitted under. A zero-length declaration answers
 * `undefined` rather than dividing by it — an empty payload has no progress to draw and
 * a bar pinned at either end would be a figure about nothing.
 */
function ingestProgressFraction(entry: AttachmentIngestEntry): number | undefined {
  if (entry.state !== "ingesting" || entry.declared.byteLength === 0) {
    return undefined;
  }
  return Math.min(1, entry.receivedBytes / entry.declared.byteLength);
}
