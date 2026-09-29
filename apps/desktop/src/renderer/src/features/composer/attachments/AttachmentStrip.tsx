// What this message is carrying, beside the line it is being written on.
//
// THE STRIP IS ABSENT WHEN NOTHING IS ATTACHED. A composer with no attachments has no
// attachment surface, and an empty row reserving space would be a permanent reminder of a
// thing nobody has done.
//
// THE COUNT IS RENDERED AND THE DAEMON DECIDES. The daemon refuses the whole staged list at
// acceptance and the bound is operator-tunable, so the running count is a figure a person
// reads and never a gate this strip closes: the eleventh file is handed to the daemon
// exactly as the first is.
//
// THE READY COUNT IS STATED WHERE THE ARTIFACTS ARE: how many settled artifacts the
// strip holds that a message can reference.

import { DerivedFigure, formatCount } from "@renderer/console/primitives/index.js";
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
    // A `section` and not a `div`: `aria-label` on a generic element names nothing. A
    // landmark takes the name, and the strip is one, a standing region beside the
    // message line.
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
