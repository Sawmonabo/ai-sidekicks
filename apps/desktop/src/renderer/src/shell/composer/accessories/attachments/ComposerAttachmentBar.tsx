// What this message is carrying, beside the line it is being written on.
//
// THE STRIP IS ABSENT WHEN NOTHING IS ATTACHED, which is the absent-not-disabled rule
// applied to a zone rather than a control: a composer with no attachments has no
// attachment surface, and an empty row reserving space would be a permanent reminder
// of a thing nobody has done.
//
// THE COUNT IS RENDERED AND THE DAEMON DECIDES. `Spec-014 §Bounds (normative defaults;
// operator-tunable)` refuses the whole carrier at acceptance and the bound is
// operator-tunable, so the running count is a figure a person reads and never a gate
// this strip closes: nothing here withdraws the picker, and the eleventh file is
// offered exactly as the first was.
//
// TWO SOURCES OF ATTACHMENT AND ONE LINE FOR BOTH. Files a person chose ride this
// session's carrier; a page a view family captured came back from that family already
// minted as an artifact. They render as one list because they are one thing to the
// message. A family row shows the artifact the pipeline minted and no ingest state,
// because there is none to show: it arrived settled, so a progress bar or a retry on it
// would be a control over work that is already finished.
//
// AND THE HOLD IS STATED WHERE THE ARTIFACTS ARE. Nothing delivers an attachment
// reference on a send today, so the strip says so beside the artifacts themselves
// rather than letting a person press Send and discover it afterwards.

import {
  Chip,
  DerivedFigure,
  WireFigure,
  formatByteQuantity,
  formatCount,
} from "../../../../console/primitives/index.js";
import {
  attachmentCarrierFill,
  type AttachmentCarrierBinding,
} from "../../../../console/repos/index.js";
import type { ComposerArtifactAttachment } from "../../../../console/seats/index.js";
import { AttachmentChip } from "./AttachmentChip.js";
import { composerAttachmentChip } from "./composer-attachment-chip.js";
import {
  ATTACHMENT_DELIVERY_HELD_COPY,
  sendAttachmentReference,
} from "./send-attachment-reference.js";

export interface ComposerAttachmentBarProps {
  readonly carrier: AttachmentCarrierBinding;
  /** Artifacts view families put on this message through the `+` menu. */
  readonly familyAttachments: readonly ComposerArtifactAttachment[];
  /** Take one family attachment back off this message. The artifact itself stays. */
  readonly onForgetFamilyAttachment: (artifactId: string) => void;
  /** True while a file drag is over the composer, so the strip can say it will land. */
  readonly isDraggingFiles: boolean;
}

export function ComposerAttachmentBar(props: ComposerAttachmentBarProps): React.JSX.Element | null {
  const { carrier, familyAttachments } = props;
  const { entries, publishedAtMilliseconds } = carrier.snapshot;
  const attachedCount = entries.length + familyAttachments.length;
  if (attachedCount === 0 && !props.isDraggingFiles) {
    return null;
  }
  // Both sources counted against one bound, because the daemon counts one carrier: a
  // figure that ignored the family rows would read as room this send does not have.
  const fill = attachmentCarrierFill(attachedCount);
  const reference = sendAttachmentReference(entries, familyAttachments);
  return (
    <div
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
            onRetry={carrier.retry}
            onAbandon={carrier.abandon}
          />
        ))}
        {familyAttachments.map((attachment) => (
          <FamilyAttachmentChip
            key={attachment.artifactId}
            attachment={attachment}
            onForget={props.onForgetFamilyAttachment}
          />
        ))}
      </ul>
      <p className="meridian-composer-attachments__fill">
        <DerivedFigure
          text={`${formatCount(fill.attached)} of ${formatCount(fill.allowance)} attached`}
        />
        <span className="meridian-composer-attachments__fill-source">
          The default bound. An operator can raise it, and the daemon decides at acceptance.
        </span>
      </p>
      {reference.disposition === "none" ? null : (
        <p className="meridian-composer-attachments__hold">
          <DerivedFigure text={`${formatCount(reference.artifactIds.length)} ready to reference`} />
          {ATTACHMENT_DELIVERY_HELD_COPY}
        </p>
      )}
    </div>
  );
}

/**
 * One artifact a view family put on this message.
 *
 * A DIFFERENT ROW FROM AN UPLOAD, deliberately: it has no ingest to watch, no retry to
 * offer, and no cancel to explain — it is already an artifact. What it shows is the
 * three things the family handed over, verbatim, and the one act still available: take
 * it back off this message, which leaves the artifact where it is.
 */
function FamilyAttachmentChip(props: {
  readonly attachment: ComposerArtifactAttachment;
  readonly onForget: (artifactId: string) => void;
}): React.JSX.Element {
  const { attachment } = props;
  // The pipeline's own figure, through the console's one byte formatter, with the
  // exact stored count on the title — the treatment an upload's size already gets.
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
