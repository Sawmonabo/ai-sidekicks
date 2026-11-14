// The attachment card a transcript row carries. The registry hands over only an opaque
// `attachmentId` and no bridge, so this body makes no read of its own and draws the attachment
// the reference names.

import "./InlineAttachmentCard.css";

import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import type { AttachmentInlineCardProps } from "#renderer/registries/inline-cards/registry.js";

/** The attachment the reference names, so it has an accessible name in the row. */
export function InlineAttachmentCard(props: {
  readonly card: AttachmentInlineCardProps;
}): React.JSX.Element {
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
