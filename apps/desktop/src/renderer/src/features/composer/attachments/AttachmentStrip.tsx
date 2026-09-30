// What a message is carrying, beside the line it is written on. Absent when nothing is attached.
// The running count is a figure, never a gate: the daemon refuses an over-long staged list at
// acceptance and the bound is operator-tunable, so the eleventh file is handed over like the
// first.

import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { stagedAttachmentsFill } from "./attachment-bounds.js";
import type { StagedAttachmentsBinding } from "./hooks/useStagedAttachments.js";
import { AttachmentChip } from "./AttachmentChip.js";
import { composerAttachmentChip } from "./composer-attachment-chip.js";
import { composeSendAttachmentReference } from "./send-attachment-reference.js";

import "./AttachmentStrip.css";

/** What the strip reads: the session's staged attachments, and whether a file is being dragged. */
export interface AttachmentStripProps {
  readonly stagedAttachments: StagedAttachmentsBinding;
  /** True while a file drag is over the composer, so the strip can say it will land. */
  readonly isDraggingFiles: boolean;
}

/** The composer's attachment strip, or `null` while nothing is attached or dragged over it. */
export function AttachmentStrip(props: AttachmentStripProps): React.JSX.Element | null {
  const { stagedAttachments } = props;
  const { entries, publishedAtMilliseconds } = stagedAttachments.snapshot;
  if (entries.length === 0 && !props.isDraggingFiles) {
    return null;
  }
  const fill = stagedAttachmentsFill(entries.length);
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
      {props.isDraggingFiles ? (
        <p className="meridian-composer-attachments__drop">Drop to attach to this message.</p>
      ) : null}
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
      <p className="meridian-composer-attachments__fill">
        <DerivedFigure
          text={`${formatCount(fill.attached)} of ${formatCount(fill.allowance)} attached`}
        />
        <span className="meridian-composer-attachments__fill-source">
          The default bound. An operator can raise it, and the background service decides at
          acceptance.
        </span>
      </p>
      {reference.disposition === "none" ? null : (
        <p className="meridian-composer-attachments__hold">
          <DerivedFigure text={`${formatCount(reference.artifactIds.length)} ready to reference`} />
        </p>
      )}
    </section>
  );
}
