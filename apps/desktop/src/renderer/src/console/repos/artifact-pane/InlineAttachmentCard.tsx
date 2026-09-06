// The attachment card a ledger row carries, and the seat registration that fills it.
//
// `Spec-023 §Meridian, the design language` rule 7 puts a secondary control one click
// away, and THIS FAMILY'S OWN RULE puts an attachment in the position the participant
// put it: an attachment belongs to the
// turn that carried it, and its marker sits in the attachment's
// DECLARED POSITION rather than being appended or footnoted — which is exactly what a
// card inside the row is, and why this is a card and not a pane.
//
// ONE BODY, NOT TWO. The card this registration mounts is the same component the
// attachment surface renders, `repos/attachments/AttachmentCard.tsx`, rather than a
// lighter one written for the timeline. A second renderer would drift from the first in
// exactly the details an unresolved marker is read for: which of the six causes, and
// what the remedy is.
//
// WHAT THE SEAT HANDS OVER, AND WHY THE READING IS `not-checked`. The seat carries
// `InlineCardAttachmentRef` — an opaque `attachmentId` and nothing else — because
// `@ai-sidekicks/contracts` exports no attachment type at all: `SteerPayload.attachments`
// is `z.array(z.unknown())`, an untyped arm `Spec-014 §Interfaces And Contracts` forbids
// delivering an attachment over, and the typed reference is Plan-014 T14.13's. There is
// therefore no read that turns this id into a manifest row and no bridge on the seat to
// attempt one with, so the reading is the arm that says nobody asked. When the typed
// reference lands, the seat's own placeholder is deleted and this arm becomes the
// resolved or unresolved reading the daemon sends.

import { AttachmentCard } from "../attachments/AttachmentCard.js";
import type { AttachmentReading } from "../attachments/attachment-shapes.js";
import type { InlineCardSeatRegistry, AttachmentInlineCardProps } from "../../seats/index.js";

/** Who owns this body, for the seat registry's owner-scoped duplicate policy. */
const INLINE_ATTACHMENT_CARD_OWNER = "repos";

/**
 * The instant the unread arm renders against, which nothing spends.
 *
 * `AttachmentCard` reaches its `nowMilliseconds` on the in-flight arm alone — the
 * stall disclosure and the stream-ceiling remainder — and the `not-checked` reading
 * this card composes has no entry to be in flight. Named and pinned rather than read
 * off a clock, so the arm that spends nothing asks nothing for it.
 */
const UNREAD_ARM_INSTANT = 0;

/**
 * What the card renders, as the two shapes it actually has.
 *
 * A UNION RATHER THAN TWO OPTIONAL MEMBERS, because the instant is meaningless without
 * the reading it is about and the pair must arrive together. This card used to take
 * the reading alone and capture `Date.now()` at MOUNT for the other half, which is the
 * defect `repos/attachments/attachment-carrier.ts` publishes `publishedAtMilliseconds` to close: a
 * frozen instant makes `isIngestStalled` compare a moment against progress stamped
 * AFTER it, so the disclosure `INGEST_STALL_DISCLOSURE_MS` exists to produce can never
 * fire, and it makes the ceiling remainder subtract a later moment from an earlier one
 * and report MORE time left than the ceiling allows. Whatever supplies the reading
 * supplies the instant it was taken at — the carrier's snapshot already carries one —
 * and the compiler now says so.
 */
export type InlineAttachmentCardProps =
  | {
      readonly card: AttachmentInlineCardProps;
      readonly reading?: undefined;
      readonly nowMilliseconds?: undefined;
    }
  | {
      readonly card: AttachmentInlineCardProps;
      /** What is known about the attachment. Absent means nobody asked — see the header. */
      readonly reading: AttachmentReading;
      /** The instant that reading was taken at, from its producer's own clock. */
      readonly nowMilliseconds: number;
    };

export function InlineAttachmentCard(props: InlineAttachmentCardProps): React.JSX.Element {
  const attachmentId = props.card.attachment.attachmentId;
  const reading: AttachmentReading = props.reading ?? { kind: "not-checked", attachmentId };
  return (
    <div className="meridian-attachment-card">
      <AttachmentCard
        reading={reading}
        nowMilliseconds={props.nowMilliseconds ?? UNREAD_ARM_INSTANT}
      />
    </div>
  );
}

/** Fill the ledger's `attachment` card seat on the board the family's own door supplies. */
export function registerInlineAttachmentCardBody(seats: InlineCardSeatRegistry): void {
  seats.register("attachment", {
    owner: INLINE_ATTACHMENT_CARD_OWNER,
    render: (cardProps) => <InlineAttachmentCard card={cardProps} />,
  });
}
