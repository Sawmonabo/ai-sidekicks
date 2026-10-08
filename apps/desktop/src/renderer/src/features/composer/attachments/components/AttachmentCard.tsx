// One attachment in the position the user put it: in flight (progress from `receivedBytes`),
// complete (the daemon's derived name, type and size replace the advisory declaration), or
// unresolved (a marker standing in the file's place). The label and the face read the same name
// from `features/composer/attachments/provenance.ts`, so a screen reader hears the identity a
// sighted user sees.

import { Fragment } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import {
  ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL,
  ATTACHMENT_DECLARED_NAME_ORIGIN,
  attachmentMediaTypeReadings,
  attachmentNameReading,
} from "../provenance.js";
import { INGEST_ABANDON_COPY, INGEST_DISPOSITION_COPY } from "../policy.js";
import { isIngestStalled } from "../presentation.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import type { AttachmentIngestEntry, AttachmentReading } from "../shapes.js";

import "./AttachmentCard.css";
import { AnnouncedLine } from "#renderer/components/AnnouncedLine/AnnouncedLine.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** Props for one attachment card. */
export interface AttachmentCardProps {
  readonly reading: AttachmentReading;
  /** The instant the card rendered at. Ages move when it re-reads and never on a timer. */
  readonly nowMilliseconds: number;
  /** Send the refused stream again, per its own disposition. */
  readonly onRetry?: ((localId: string) => void) | undefined;
  /** Stop sending. There is no cancel call, so this is abandonment and says so. */
  readonly onAbandon?: ((localId: string) => void) | undefined;
}

/** Renders one attachment reading as an in-flight, resolved, or unresolved card. */
export function AttachmentCard(props: AttachmentCardProps): React.JSX.Element {
  const { reading } = props;
  return (
    <article className="meridian-attachment" aria-label={attachmentLabel(reading)}>
      {reading.kind === "ingesting" ? renderIngesting(reading.entry, props) : null}
      {reading.kind === "resolved" ? (
        <div className="meridian-attachment__face">
          <Glyph name="artifact" size={GLYPH_SIZE_ROW} />
          <WireFigure value={reading.derived.fileName} />
          <Chip label={reading.derived.mimeType} mono />
          <WireFigure
            value={formatByteQuantity(reading.derived.sizeBytes).text}
            hoverLabel={String(reading.derived.sizeBytes)}
          />
          <span className="meridian-attachment__artifact-id">
            <WireFigure value={reading.derived.artifactId} />
          </span>
        </div>
      ) : null}
      {reading.kind === "unresolved" ? renderUnresolved(reading.attachmentId) : null}
    </article>
  );
}

/** What a screen reader is told this card is about, in every arm. */
function attachmentLabel(reading: AttachmentReading): string {
  if (reading.kind === "ingesting") {
    return `Attachment ${attachmentNameReading(reading.entry).name}`;
  }
  if (reading.kind === "resolved") {
    return `Attachment ${reading.derived.fileName}`;
  }
  return `Attachment ${reading.attachmentId}`;
}

/**
 * The in-flight arm: the declaration, progress, and the two controls. The declaration renders
 * as a wire string labeled as declared; the resolved arm replaces it wholesale.
 */
function renderIngesting(
  entry: AttachmentIngestEntry,
  props: AttachmentCardProps,
): React.JSX.Element {
  const receivedFigure = formatByteQuantity(entry.receivedBytes);
  const declaredFigure = formatByteQuantity(entry.declared.byteLength);
  const nameReading = attachmentNameReading(entry);
  return (
    <>
      <div className="meridian-attachment__face">
        <Glyph name="artifact" size={GLYPH_SIZE_ROW} />
        <WireFigure
          value={nameReading.name}
          hoverLabel={
            nameReading.provenance === "declared" ? ATTACHMENT_DECLARED_NAME_ORIGIN : undefined
          }
        />
        {/* Either reading earns the chip; where they disagree both show, derived first. Labeled
            by provenance because color cannot say whose claim a media type is. */}
        {attachmentMediaTypeReadings(entry).map((mediaTypeReading) => (
          <Fragment key={mediaTypeReading.provenance}>
            {mediaTypeReading.provenance === "declared" ? (
              <span>{ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL}</span>
            ) : null}
            <Chip
              label={mediaTypeReading.mediaType}
              mono
              tone={mediaTypeReading.provenance === "derived" ? "accent" : "neutral"}
            />
          </Fragment>
        ))}
        <span className="meridian-attachment__bytes">
          <WireFigure value={receivedFigure.text} hoverLabel={String(entry.receivedBytes)} />
          <span>of</span>
          <WireFigure value={declaredFigure.text} hoverLabel={String(entry.declared.byteLength)} />
        </span>
        <Chip
          label={codeWords(entry.state)}
          tone={entry.state === "refused" ? "failure" : "neutral"}
        />
      </div>

      {/* The raw counts are a measurement; the scaled pair above is what a reader sees. */}
      <progress
        className="meridian-attachment__progress"
        max={Math.max(1, entry.declared.byteLength)}
        value={entry.receivedBytes}
        aria-label={`Uploaded ${receivedFigure.text} of ${declaredFigure.text}`}
      />

      {isIngestStalled(entry, props.nowMilliseconds) ? (
        <AnnouncedLine
          element="p"
          className="meridian-attachment__note"
          words="This upload has gone quiet."
          politeness="polite"
        />
      ) : null}

      {entry.refusal === undefined ? null : (
        <div className="meridian-attachment__refusal">
          <InlineRefusal code={entry.refusal.code} detail={entry.refusal.detail} />
          {entry.disposition === undefined ? null : (
            <p className="meridian-attachment__note">
              {INGEST_DISPOSITION_COPY[entry.disposition]}
            </p>
          )}
        </div>
      )}

      <div className="meridian-attachment__acts">
        {props.onRetry === undefined || entry.state !== "refused" ? null : (
          <button
            type="button"
            className="meridian-attachment__act"
            onClick={() => props.onRetry?.(entry.declared.localId)}
          >
            {entry.disposition === "restart" ? "Upload again" : "Send again"}
          </button>
        )}
        {props.onAbandon === undefined ||
        entry.state === "complete" ||
        entry.state === "abandoned" ? null : (
          <HoverLabel text={INGEST_ABANDON_COPY} textRole="description">
            <button
              type="button"
              className="meridian-attachment__act"
              onClick={() => props.onAbandon?.(entry.declared.localId)}
            >
              Stop sending
            </button>
          </HoverLabel>
        )}
      </div>

      {entry.state === "abandoned" ? (
        <AnnouncedLine
          element="p"
          className="meridian-attachment__note"
          words={INGEST_ABANDON_COPY}
          politeness="polite"
        />
      ) : null}
    </>
  );
}

/** The unresolved arm: a marker in the file's own place, naming the attachment by its id. */
function renderUnresolved(attachmentId: string): React.JSX.Element {
  return (
    <div className="meridian-attachment__unresolved">
      <div className="meridian-attachment__face">
        <Glyph name="alert" size={GLYPH_SIZE_ROW} />
        <span className="meridian-attachment__artifact-id">
          <WireFigure value={attachmentId} />
        </span>
      </div>
    </div>
  );
}
