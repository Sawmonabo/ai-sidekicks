// One attachment, in the position the participant put it, whatever became of it.
//
// THE ATTACHMENT SURFACE'S COMPOSITION IS THIS FAMILY'S, because `Spec-023 §Console
// Design (Meridian)` puts a surface's composition in the console's code. Four arms, and
// the reason there are four rather than a card with flags is `attachment-shapes.ts`'s
// own Never list, which separates them:
//
//   • IN FLIGHT — progress from `receivedBytes`, the spooled running total of DECODED
//     bytes, with the six-hour stream ceiling disclosed once the upload has gone quiet.
//   • COMPLETE — the derived truth REPLACES the declaration. `normalizedName`,
//     `derivedMediaType`, `derivedSizeBytes`, and the minted artifact id, because a
//     declared type or size is advisory input and never a trusted fact.
//   • UNRESOLVED — the marker sits HERE, in the declared position, naming one of six
//     causes and its own remedy. Never appended, never footnoted, and the turn proceeds
//     around it.
//   • NOT CHECKED — nobody asked. Every attachment on a turn is in this arm today,
//     because no registered wire resolves an attachment reference, and saying "there is
//     nothing here" instead would be the console asserting a read it never performed.
//
// THE DECLARED FILENAME IS NEVER REBUILT. `Spec-014 §Ingest Validation And Payload
// Bounds (V1)` keeps every caller-supplied string out of every path component and lets
// the original survive as manifest metadata only, so the declaration renders as a wire
// string in the in-flight arm and is REPLACED by `normalizedName` the moment one
// exists. Nothing in this file concatenates a name with anything.
//
// AND THE LABEL READS THE SAME NAME THE FACE DOES, from one place. A completed ingest
// stays on the in-flight arm of the reading — `complete` is a state of an entry, not a
// second reading — so the face had switched to the daemon's normalized name while the
// accessible label was still reading the declaration beside it. On exactly the
// attachments where normalization changed something, a screen-reader user heard a
// different artifact identity from a sighted one. `attachment-provenance.ts` answers
// which name an entry goes by, and both renderings ask it.
//
// EVERY BYTE FIGURE GOES THROUGH THE CHOKEPOINT. `formatByteQuantity` is the console's
// only byte formatter and this card holds no arithmetic of its own; the raw counts
// reach the progress element as attributes, which are a measurement rather than a
// figure a person reads.

import { Fragment } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatByteQuantity,
  formatDuration,
} from "../../primitives/index.js";
import {
  ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL,
  attachmentMediaTypeReadings,
  attachmentNameReading,
} from "./attachment-provenance.js";
import {
  INGEST_ABANDON_COPY,
  INGEST_DISPOSITION_COPY,
  type UnresolvedAttachmentCause,
} from "./attachment-policy.js";
import {
  UNRESOLVED_ATTACHMENT_PRESENTATION,
  ingestCeilingRemainingMs,
  isIngestStalled,
} from "./attachment-presentation.js";
import { GLYPH_SIZE_ROW } from "../../tokens/index.js";
import type { AttachmentIngestEntry, AttachmentReading } from "./attachment-shapes.js";

/** Whose claim a name is, where the name shown is still the caller's own. */
const DECLARED_NAME_TITLE = "Declared by the sender";

export interface AttachmentCardProps {
  readonly reading: AttachmentReading;
  /** The instant the surface rendered at. Ages move when it re-reads and never on a timer. */
  readonly nowMilliseconds: number;
  /** Send the refused stream again, per its own disposition. */
  readonly onRetry?: ((localId: string) => void) | undefined;
  /** Stop sending. There is no cancel call, so this is abandonment and says so. */
  readonly onAbandon?: ((localId: string) => void) | undefined;
}

export function AttachmentCard(props: AttachmentCardProps): React.JSX.Element {
  const { reading } = props;
  return (
    <article className="meridian-attachment" aria-label={attachmentLabel(reading)}>
      {reading.kind === "ingesting" ? renderIngesting(reading.entry, props) : null}
      {reading.kind === "resolved" ? (
        <div className="meridian-attachment__face">
          <Glyph name="artifact" size={GLYPH_SIZE_ROW} />
          <WireFigure value={reading.derived.normalizedName} />
          <Chip label={reading.derived.derivedMediaType} mono />
          <WireFigure
            value={formatByteQuantity(reading.derived.derivedSizeBytes).text}
            title={String(reading.derived.derivedSizeBytes)}
          />
          <span className="meridian-attachment__artifact-id">
            <WireFigure value={reading.derived.artifactId} />
          </span>
        </div>
      ) : null}
      {reading.kind === "unresolved" ? renderUnresolved(reading.attachmentId, reading.cause) : null}
      {reading.kind === "not-checked" ? (
        <Nothing
          kind="not-checked"
          placement="inline"
          title="This attachment has not been resolved."
          detail="The read that turns an attachment reference into a manifest row is not registered on the bridge yet, so nothing has been asked for and nothing is being reported as missing."
        />
      ) : null}
    </article>
  );
}

/** What a screen reader is told this card is about, in every arm. */
function attachmentLabel(reading: AttachmentReading): string {
  if (reading.kind === "ingesting") {
    return `Attachment ${attachmentNameReading(reading.entry).name}`;
  }
  if (reading.kind === "resolved") {
    return `Attachment ${reading.derived.normalizedName}`;
  }
  return `Attachment ${reading.attachmentId}`;
}

/**
 * The in-flight arm: the declaration, the ledger, and the two controls.
 *
 * The declaration is rendered as a wire string and labelled as declared, so a
 * participant reading a name here knows it is theirs and not the server's finding. It
 * is replaced wholesale by the resolved arm rather than annotated in place.
 */
function renderIngesting(
  entry: AttachmentIngestEntry,
  props: AttachmentCardProps,
): React.JSX.Element {
  const receivedFigure = formatByteQuantity(entry.receivedBytes);
  const declaredFigure = formatByteQuantity(entry.declared.byteLength);
  const ceilingRemainingMs = ingestCeilingRemainingMs(entry, props.nowMilliseconds);
  const nameReading = attachmentNameReading(entry);
  return (
    <>
      <div className="meridian-attachment__face">
        <Glyph name="artifact" size={GLYPH_SIZE_ROW} />
        {nameReading.provenance === "declared" ? (
          <WireFigure value={nameReading.name} title={DECLARED_NAME_TITLE} />
        ) : (
          <WireFigure value={nameReading.name} />
        )}
        {/* EITHER READING EARNS THE CHIP, and where the two disagree both are shown
            with the derived one leading. `attachment-provenance.ts` owns the rule; this
            renders it. Labelled by provenance rather than by tone alone, because a
            colour cannot say whose claim a media type is. */}
        {attachmentMediaTypeReadings(entry).map((mediaTypeReading) => (
          <Fragment key={mediaTypeReading.provenance}>
            {mediaTypeReading.provenance === "declared" ? (
              <DerivedFigure text={ATTACHMENT_DECLARED_MEDIA_TYPE_LABEL} />
            ) : null}
            <Chip
              label={mediaTypeReading.mediaType}
              mono
              tone={mediaTypeReading.provenance === "derived" ? "accent" : "neutral"}
            />
          </Fragment>
        ))}
        <span className="meridian-attachment__bytes">
          <WireFigure value={receivedFigure.text} title={String(entry.receivedBytes)} />
          <DerivedFigure text="of" />
          <WireFigure value={declaredFigure.text} title={String(entry.declared.byteLength)} />
        </span>
        <Chip label={entry.state} mono tone={entry.state === "refused" ? "failure" : "neutral"} />
      </div>

      {/* The measurement, not a figure: the element takes the raw decoded counts and
          the reader gets the scaled pair above it. A percentage rendered here would be
          a second byte formatter wearing a different unit. */}
      <progress
        className="meridian-attachment__progress"
        max={Math.max(1, entry.declared.byteLength)}
        value={entry.receivedBytes}
        aria-label={`Uploaded ${receivedFigure.text} of ${declaredFigure.text}`}
      />

      {isIngestStalled(entry, props.nowMilliseconds) && ceilingRemainingMs !== undefined ? (
        <p className="meridian-attachment__note" role="status">
          This upload has gone quiet. One ingest stream is bounded at six hours from the moment it
          opened; <DerivedFigure text={formatDuration(ceilingRemainingMs)} /> of that remains.
        </p>
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
          <button
            type="button"
            className="meridian-attachment__act"
            title={INGEST_ABANDON_COPY}
            onClick={() => props.onAbandon?.(entry.declared.localId)}
          >
            Stop sending
          </button>
        )}
      </div>

      {entry.state === "abandoned" ? (
        <p className="meridian-attachment__note" role="status">
          {INGEST_ABANDON_COPY}
        </p>
      ) : null}
    </>
  );
}

/**
 * The unresolved arm: one of six causes, its own sentence, and its own remedy.
 *
 * The cause is read from the reading node's own manifest row and rendered verbatim; the
 * console recomputes nothing from live relay state, which is exactly what lets a marker
 * carry a non-pinned replication status as its cause. A cause with no remedy says so.
 */
function renderUnresolved(
  attachmentId: string,
  cause: UnresolvedAttachmentCause,
): React.JSX.Element {
  const presentation = UNRESOLVED_ATTACHMENT_PRESENTATION[cause];
  return (
    <div className="meridian-attachment__unresolved">
      <div className="meridian-attachment__face">
        <Glyph name="alert" size={GLYPH_SIZE_ROW} />
        <Chip label={cause} mono tone="attention" />
        <span className="meridian-attachment__artifact-id">
          <WireFigure value={attachmentId} />
        </span>
      </div>
      <p className="meridian-attachment__note">{presentation.meaning}</p>
      <p className="meridian-attachment__note">
        {presentation.remedy ?? "There is no way to restore it."}
      </p>
    </div>
  );
}
