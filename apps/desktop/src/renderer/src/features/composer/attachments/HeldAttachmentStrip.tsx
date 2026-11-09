// The files the session's held draft carries, beside the line it is written on: a message a Stop
// put back, or a draft saved on another device, arrives with its files staged, and each shows as
// the name, type and size the daemon found when it copied it. Absent when the draft holds none.

import type { SessionAttachmentSummary } from "@ai-sidekicks/contracts/session/draft";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";

import "./AttachmentStrip.css";

/** What the strip reads: the held draft's staged files, in the draft's order. */
export interface HeldAttachmentStripProps {
  readonly files: readonly SessionAttachmentSummary[];
}

/** The held draft's files as one-line chips, or `null` while it holds none. */
export function HeldAttachmentStrip(props: HeldAttachmentStripProps): React.JSX.Element | null {
  if (props.files.length === 0) {
    return null;
  }
  return (
    <section className="meridian-composer-attachments" aria-label="Attachments on this message">
      <ul className="meridian-composer-attachments__list">
        {props.files.map((file) => {
          const size = formatByteQuantity(file.sizeBytes);
          return (
            <li
              key={file.artifactId}
              className="meridian-composer-attachment"
              aria-label={`Attachment ${file.fileName}`}
            >
              <span className="meridian-composer-attachment__line">
                <WireFigure value={file.fileName} />
                <Chip label={file.mimeType} mono glyph="artifact" />
                <WireFigure value={size.text} hoverLabel={size.exactText} />
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
