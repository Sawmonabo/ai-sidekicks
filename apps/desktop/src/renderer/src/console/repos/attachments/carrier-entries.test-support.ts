// One carrier's worth of entries, built the same way wherever a case needs one.
//
// HOISTED ON THE SECOND USE, which is this package's rule and is load-bearing here for
// a specific reason: the reorder arithmetic is checked in one tier, the keyboard path
// in a second, and the pointer drag in a third, and all three read positions off the
// SAME list. Three local builders would let one tier's fixture drift — a different
// declared order, a different name — and the tiers would then disagree about where an
// attachment ended up while each stayed internally green.
//
// EVERY ENTRY IS `ingesting` AND HOLDS ITS BYTES. Reordering is about the declared
// order and nothing else, so the state is the one arm that carries a payload and no
// case here has to think about which union member it is holding.

import {
  attachmentSourceFrom,
  type AttachmentIngestEntry,
  type SendingAttachmentIngestEntry,
} from "./attachment-shapes.js";

/** The moment these entries were opened and last heard from. */
export const CARRIER_ENTRY_MILLISECONDS = 1_000;

/** The declared media type every built entry carries — one the shipped list admits. */
const CARRIER_ENTRY_MEDIA_TYPE = "text/markdown";

/**
 * One attachment, mid-ingest, with the declared length the payload actually has.
 *
 * The length comes off the `Blob` through `attachmentSourceFrom` rather than being
 * passed beside it, because that is the only way the production code mints a
 * declaration — a fixture that set the two independently could state a size no
 * attachment in the tree can have.
 */
export function carrierEntry(
  localId: string,
  declaredName: string,
  byteLength = 300,
): SendingAttachmentIngestEntry {
  return {
    ...attachmentSourceFrom({
      localId,
      declaredName,
      payload: new Blob([new Uint8Array(byteLength)]),
      declaredMediaType: CARRIER_ENTRY_MEDIA_TYPE,
    }),
    state: "ingesting",
    receivedBytes: 0,
    ingestId: undefined,
    derived: undefined,
    refusal: undefined,
    disposition: undefined,
    openedAtMilliseconds: CARRIER_ENTRY_MILLISECONDS,
    lastProgressAtMilliseconds: CARRIER_ENTRY_MILLISECONDS,
  };
}

/** Three attachments in declared order — enough for a move in either direction. */
export function threeAttachmentCarrier(): readonly AttachmentIngestEntry[] {
  return [
    carrierEntry("attachment-1", "first.md"),
    carrierEntry("attachment-2", "second.md"),
    carrierEntry("attachment-3", "third.md"),
  ];
}
