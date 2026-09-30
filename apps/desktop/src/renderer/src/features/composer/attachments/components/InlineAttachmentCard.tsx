// The attachment card a transcript row carries.
//
// An attachment belongs to the turn that carried it and sits in its declared position, which
// is what a card inside the row is, and why this is a card and not a pane.
//
// One body, not two: the card this draws is the same component the attachment strip
// renders, `AttachmentCard.tsx`, so the two cannot drift in the details an unresolved marker
// is read for.
//
// The inline card registry hands over `InlineCardAttachmentRef`, an opaque `attachmentId`
// and nothing else, and no bridge, so this body makes no read. It draws the card when
// its caller supplies a reading, and the reference it was given when not.

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { AttachmentInlineCardProps } from "@renderer/registries/inline-cards/inline-card-registry.js";
import type { AttachmentReading } from "../attachment-shapes.js";
import { AttachmentCard } from "./AttachmentCard.js";

/**
 * What the card renders, as the two shapes it has.
 *
 * A union rather than two optional members, because the instant is meaningless without the
 * reading it is about and the pair must arrive together. Whatever supplies the reading
 * supplies the instant it was taken at, from its own clock; a card that captured
 * `Date.now()` at mount would compare a moment against progress stamped after it.
 */
export type InlineAttachmentCardProps =
  | {
      readonly card: AttachmentInlineCardProps;
      readonly reading?: undefined;
      readonly nowMilliseconds?: undefined;
    }
  | {
      readonly card: AttachmentInlineCardProps;
      /** What is known about the attachment. */
      readonly reading: AttachmentReading;
      /** The instant that reading was taken at, from its producer's own clock. */
      readonly nowMilliseconds: number;
    };

/**
 * The attachment card when a reading is supplied, and the attachment id when not.
 *
 * The bare id is named by the reference's attachment id, so it has an accessible name before a
 * reading arrives; the attachment card names itself.
 */
export function InlineAttachmentCard(props: InlineAttachmentCardProps): React.JSX.Element {
  if (props.reading !== undefined) {
    return (
      <div className="meridian-attachment-card">
        <AttachmentCard reading={props.reading} nowMilliseconds={props.nowMilliseconds} />
      </div>
    );
  }
  return (
    <div
      className="meridian-attachment-card"
      role="group"
      aria-label={`Attachment ${props.card.attachment.attachmentId}`}
    >
      <WireFigure value={props.card.attachment.attachmentId} />
    </div>
  );
}
