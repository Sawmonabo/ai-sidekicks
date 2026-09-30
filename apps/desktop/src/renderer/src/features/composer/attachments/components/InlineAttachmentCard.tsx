// The attachment card a transcript row carries. It draws the same `AttachmentCard` the strip
// does, so an unresolved marker reads identically. The registry hands over only an opaque
// `attachmentId` and no bridge, so this body makes no read of its own.

import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import type { AttachmentInlineCardProps } from "@renderer/registries/inline-cards/inline-card-registry.js";
import type { AttachmentReading } from "../attachment-shapes.js";
import { AttachmentCard } from "./AttachmentCard.js";

/**
 * Either a bare reference or a reference with its reading. The reading and the instant arrive
 * together, from the producer's own clock: an instant captured at mount would predate progress.
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
 * The attachment card when a reading is supplied, otherwise the attachment id named by the
 * reference, so it has an accessible name before a reading arrives.
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
