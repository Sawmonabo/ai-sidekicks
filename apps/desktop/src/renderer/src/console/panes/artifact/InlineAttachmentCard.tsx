// The attachment card a ledger row carries, and the seat registration that fills it.
//
// `Spec-023 §Console Design (Meridian)` rule 7 and §10.8. An attachment belongs to the
// turn that carried it, and §10.8 requires its marker to sit in the attachment's
// DECLARED POSITION rather than being appended or footnoted — which is exactly what a
// card inside the row is, and why this is a card and not a pane.
//
// ONE BODY, NOT TWO. The card this registration mounts is `repos/AttachmentCard.tsx` —
// the same component the attachment surface renders — rather than a lighter one written
// for the timeline. A second renderer would drift from the first in exactly the details
// an unresolved marker is read for: which of the six causes, and what the remedy is.
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

import { useMemo } from "react";

import { AttachmentCard } from "../../repos/AttachmentCard.js";
import type { AttachmentReading } from "../../repos/attachment-model.js";
import { registerInlineCardBody, type AttachmentInlineCardProps } from "../../workspace/index.js";

/** Who owns this body, for the seat registry's owner-scoped duplicate policy. */
const INLINE_ATTACHMENT_CARD_OWNER = "repos";

export interface InlineAttachmentCardProps {
  readonly card: AttachmentInlineCardProps;
  /** What is known about the attachment. Absent means nobody asked — see the header. */
  readonly reading?: AttachmentReading;
}

export function InlineAttachmentCard(props: InlineAttachmentCardProps): React.JSX.Element {
  const attachmentId = props.card.attachment.attachmentId;
  // The instant this card was mounted at, captured once. It feeds the stall and ceiling
  // readings on an in-flight arm; a card that recomputed it every render would move an
  // age under a reader without a read having happened.
  const nowMilliseconds = useMemo(() => Date.now(), []);
  const reading: AttachmentReading = props.reading ?? { kind: "not-checked", attachmentId };
  return (
    <div className="meridian-attachment-card">
      <AttachmentCard reading={reading} nowMilliseconds={nowMilliseconds} />
    </div>
  );
}

/** Fill the ledger's `attachment` card seat. Called from the repos family's own door. */
export function registerInlineAttachmentCardBody(): void {
  registerInlineCardBody("attachment", {
    owner: INLINE_ATTACHMENT_CARD_OWNER,
    render: (cardProps) => <InlineAttachmentCard card={cardProps} />,
  });
}
