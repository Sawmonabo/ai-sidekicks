// The composer's attachment strip: one chip per staged file, its name and size as the daemon found
// them and its own `×`, a chip for each file still copying whose size slot reads `Copying…` past
// the short delay, a pick of several files that was not taken whole saying how many were, and one
// line per file that was not staged. Present only while something is staged, copying or refused,
// so the composer carries no standing tray.

import type { SessionAttachmentSummary } from "@ai-sidekicks/contracts/session/draft";

import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { LoadingNotice } from "#renderer/components/LoadingNotice/LoadingNotice.js";
import { TryAgainButton } from "#renderer/components/TryAgainButton/TryAgainButton.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { SessionStore } from "#renderer/store/session/store.js";
import { useLeadProviderName } from "../../hooks/useLeadProviderName.js";
import {
  stagingRefusalWords,
  type ComposerStaging,
  type ComposerStagingSnapshot,
  type StagingRefusalLine,
} from "../staging.js";

import "./ComposerAttachmentStrip.css";

/** What the strip draws: the held draft's staged files and the staging beside them. */
export interface ComposerAttachmentStripProps {
  readonly sessionStore: SessionStore;
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
    snapshot.pickerRefusal === undefined &&
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
      {snapshot.pickCount === undefined ? null : (
        <AnnouncedLine
          element="p"
          className="meridian-composer-attachment__remedy"
          words={`${String(snapshot.pickCount.attached)} of ${String(snapshot.pickCount.offered)} attached`}
          politeness="assertive"
        />
      )}
      {snapshot.refusals.map((refusal) => (
        <StagingRefusal
          key={refusal.clientStagingId}
          sessionStore={props.sessionStore}
          staging={staging}
          refusal={refusal}
        />
      ))}
      {snapshot.pickerRefusal === undefined ? null : (
        <InlineRefusal code={snapshot.pickerRefusal.code} detail={snapshot.pickerRefusal.detail} />
      )}
    </section>
  );
}

/** One file's `<name> was not attached · <cause>` line, with `Try again` on a failed copy. */
function StagingRefusal(props: {
  readonly sessionStore: SessionStore;
  readonly staging: ComposerStaging;
  readonly refusal: StagingRefusalLine;
}): React.JSX.Element {
  const { refusal, staging } = props;
  const providerName = useLeadProviderName(props.sessionStore);
  const line = `${refusal.name} was not attached · ${stagingRefusalWords(refusal.cause, providerName)}`;
  return (
    <AnnouncedLine
      element="p"
      className="meridian-composer-attachment__remedy"
      words={line}
      politeness="assertive"
    >
      {line}
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
  );
}
