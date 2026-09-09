// One artifact a view family put on this message.
//
// A DIFFERENT ROW FROM AN UPLOAD, deliberately: it has no ingest to watch, no retry to
// offer, and no cancel to explain — it is already an artifact. What it shows is the three
// things the family handed over, verbatim, and the one act still available: take it back
// off this message, which leaves the artifact where it is.
//
// ITS OWN MODULE BECAUSE IT IS ITS OWN COMPONENT. The strip renders both row kinds and
// this one shares none of the other's state, so keeping the two in one file would be one
// module declaring two components — the shape this package's structure rules reject, and
// a real one here rather than a formality: an upload row is a fold over ingest state and
// this is a projection of three settled members.

import { Chip, WireFigure, formatByteQuantity } from "../../../../console/primitives/index.js";
import type { ComposerArtifactAttachment } from "../../../../console/seats/index.js";

export interface FamilyAttachmentChipProps {
  readonly attachment: ComposerArtifactAttachment;
  /** Take this off the message. The artifact itself stays in the session. */
  readonly onForget: (artifactId: string) => void;
}

export function FamilyAttachmentChip(props: FamilyAttachmentChipProps): React.JSX.Element {
  const { attachment } = props;
  // The pipeline's own figure, through the console's one byte formatter, with the exact
  // stored count on the title — the treatment an upload's size already gets.
  const sizeFigure = formatByteQuantity(attachment.byteLength);
  return (
    <li className="meridian-composer-attachment" aria-label={`Attachment ${attachment.artifactId}`}>
      <span className="meridian-composer-attachment__line">
        <WireFigure value={attachment.artifactId} />
        <Chip label={attachment.mediaType} mono glyph="artifact" />
        <WireFigure value={sizeFigure.text} title={String(attachment.byteLength)} />
        <button
          type="button"
          className="meridian-composer-attachment__act"
          title="Take this off the message. The artifact stays in the session."
          onClick={() => {
            props.onForget(attachment.artifactId);
          }}
        >
          Remove
        </button>
      </span>
    </li>
  );
}
