// What a message is carrying, beside the line it is written on. Absent when nothing is attached.
// The staging bounds are the daemon's and the provider's, read at acceptance and never written
// here, so the strip draws no count against them.

import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { formatCount } from "@renderer/lib/wire/figures.js";
import type { StagedAttachmentsBinding } from "./hooks/useStagedAttachments.js";
import { AttachmentChip } from "./AttachmentChip.js";
import { composerAttachmentChip } from "./composer-attachment-chip.js";
import { composeSendAttachmentReference } from "./send-attachment-reference.js";

import "./AttachmentStrip.css";

/** What the strip reads: the session's staged attachments, and whether a file is being dragged. */
export interface AttachmentStripProps {
  readonly stagedAttachments: StagedAttachmentsBinding;
  /** True while a file drag is over the composer, which the strip shows as a tint alone. */
  readonly isDraggingFiles: boolean;
}

/** The composer's attachment strip, or `null` while nothing is attached or dragged over it. */
export function AttachmentStrip(props: AttachmentStripProps): React.JSX.Element | null {
  const { stagedAttachments } = props;
  const { entries, publishedAtMilliseconds } = stagedAttachments.snapshot;
  if (entries.length === 0 && !props.isDraggingFiles) {
    return null;
  }
  const reference = composeSendAttachmentReference(entries);
  return (
    // A `section` because `aria-label` on a generic element names nothing.
    <section
      className={
        props.isDraggingFiles
          ? "meridian-composer-attachments meridian-composer-attachments--drag"
          : "meridian-composer-attachments"
      }
      aria-label="Attachments on this message"
    >
      <ul className="meridian-composer-attachments__list">
        {entries.map((entry) => (
          <AttachmentChip
            key={entry.declared.localId}
            chip={composerAttachmentChip(entry, publishedAtMilliseconds)}
            onRetry={stagedAttachments.retry}
            onAbandon={stagedAttachments.abandon}
          />
        ))}
      </ul>
      {reference.disposition === "none" ? null : (
        <p className="meridian-composer-attachments__hold">
          <DerivedFigure text={`${formatCount(reference.artifactIds.length)} ready to reference`} />
        </p>
      )}
    </section>
  );
}
