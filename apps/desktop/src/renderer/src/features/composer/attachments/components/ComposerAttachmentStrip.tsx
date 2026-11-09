// The composer's attachment strip: one chip per staged file, its name and size as the daemon found
// them and its own `×`, a chip for each file still copying whose size slot reads `Copying…` past
// the short delay, and one line per file the daemon would not stage. Present only while something
// is staged, copying or refused, so the composer carries no standing tray.

import type { SessionAttachmentSummary } from "@ai-sidekicks/contracts/session/draft";

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { ComposerStaging, ComposerStagingSnapshot } from "../staging.js";

import "./ComposerAttachmentStrip.css";

/** What the strip draws: the held draft's staged files and the staging beside them. */
export interface ComposerAttachmentStripProps {
  readonly files: readonly SessionAttachmentSummary[];
  readonly staging: ComposerStaging;
  readonly snapshot: ComposerStagingSnapshot;
  /** Whether a file drag is over the composer, which tints the strip. */
  readonly isDraggingFiles: boolean;
}

/** The strip, or `null` while nothing is staged, copying, refused or dragged over. */
export function ComposerAttachmentStrip(
  props: ComposerAttachmentStripProps,
): React.JSX.Element | null {
  const clock = useClock();
  const { files, snapshot, staging } = props;
  if (
    files.length === 0 &&
    snapshot.pending.length === 0 &&
    snapshot.refusals.length === 0 &&
    !props.isDraggingFiles
  ) {
    return null;
  }
  return (
    <section
      className={`meridian-composer-attachments${props.isDraggingFiles ? " meridian-composer-attachments--drag" : ""}`}
      aria-label="Attachments on this message"
    >
      <ul className="meridian-composer-attachments__list">
        {files.map((file) => {
          const size = formatByteQuantity(file.sizeBytes);
          return (
            <li key={file.artifactId} className="meridian-composer-attachment">
              <span className="meridian-composer-attachment__line">
                <Glyph name="artifact" />
                <WireFigure value={file.fileName} />
                <WireFigure value={size.text} hoverLabel={size.exactText} />
                <button
                  type="button"
                  className="meridian-composer-attachment__act"
                  aria-label={`Remove ${file.fileName}`}
                  onClick={() => {
                    staging.unstage(file.artifactId);
                  }}
                >
                  <Glyph name="close" />
                </button>
              </span>
            </li>
          );
        })}
        {snapshot.pending.map((pending) => (
          <li key={pending.clientStagingId} className="meridian-composer-attachment">
            <span className="meridian-composer-attachment__line">
              <Glyph name="artifact" />
              <WireFigure value={pending.name} />
              <LoadingNotice title="Copying…" placement="inline" clock={clock} />
            </span>
          </li>
        ))}
      </ul>
      {snapshot.refusals.map((refusal) => (
        <AnnouncedLine
          key={refusal.clientStagingId}
          element="p"
          className="meridian-composer-attachment__remedy"
          words={`${refusal.name} was not attached · ${refusal.cause}`}
          politeness="assertive"
        >
          {`${refusal.name} was not attached · ${refusal.cause}`}
          {refusal.retry === undefined ? null : (
            <>
              {" "}
              <TryAgainButton
                onPress={() => {
                  staging.retry(refusal.clientStagingId);
                }}
              />
            </>
          )}
        </AnnouncedLine>
      ))}
    </section>
  );
}
