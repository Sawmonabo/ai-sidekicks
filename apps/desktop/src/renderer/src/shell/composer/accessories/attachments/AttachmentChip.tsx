// One attachment, on one line, beside the message it will ride with.
//
// A CHIP AND NOT A CARD, which is the composer's density rather than a lesser version
// of the artifact pane's row: name, type, and size in one line with progress inline, so
// a carrier of several does not push the message input off the bottom of the workspace.
// The pane's card is where an upload is READ; this is where it is watched while a
// person keeps typing.
//
// EVERY WORD IT SAYS IS THE FOLD'S. This file branches on a model and renders; it looks
// nothing up, formats no figure, and decides no eligibility. `composer-attachment-chip.ts`
// composes that model out of the repos family's own readings, so the chip and the card
// cannot describe one upload differently.
//
// CANCEL SAYS WHAT CANCELLING DOES. There is no cancel call in the ingest trio, so
// stopping is client-side abandonment and the daemon's reaper claims the spool — the
// control's own title carries that sentence verbatim rather than a softer "cancelled",
// which would promise an instant reclaim nothing performs.

import {
  Chip,
  DerivedFigure,
  InlineRefusal,
  WireFigure,
} from "../../../../console/primitives/index.js";
import type { ComposerAttachmentChipModel } from "./composer-attachment-chip.js";

export interface AttachmentChipProps {
  readonly chip: ComposerAttachmentChipModel;
  readonly onRetry: (localId: string) => void;
  readonly onAbandon: (localId: string) => void;
}

export function AttachmentChip(props: AttachmentChipProps): React.JSX.Element {
  const { chip } = props;
  return (
    <li className="meridian-composer-attachment" aria-label={`Attachment ${chip.name}`}>
      <span className="meridian-composer-attachment__line">
        {/* The manifest's name renders as the wire string it is; the caller's own claim
            renders as the console-composed figure it is, so the two never read alike. */}
        {chip.nameIsDeclared ? (
          <DerivedFigure text={chip.name} />
        ) : (
          <WireFigure value={chip.name} />
        )}
        {chip.mediaType === undefined ? null : (
          <Chip label={chip.mediaType} mono glyph="artifact" />
        )}
        {chip.mediaTypeQualifier === undefined ? null : (
          <span className="meridian-composer-attachment__qualifier">{chip.mediaTypeQualifier}</span>
        )}
        <WireFigure value={chip.sizeText} title={chip.sizeTitle} />
        <Chip label={chip.state} mono tone={chip.tone} />
        {chip.progressFraction === undefined ? null : (
          // NAMED FOR WHAT IT MEASURES AND FOR WHICH FILE. It was named `Uploaded
          // ${sizeText}` — the DECLARED total, which is what has not been uploaded
          // yet — so a carrier of several announced as several bars each claiming a
          // number that was never a progress figure at all. `value` and `max` carry
          // the amount, as a fraction of the declaration; the name says whose.
          <progress
            className="meridian-composer-attachment__progress"
            max={1}
            value={chip.progressFraction}
            aria-label={`Upload progress for ${chip.name}`}
          />
        )}
        {chip.isStalled ? (
          <span className="meridian-composer-attachment__note">
            No chunk has been acknowledged for a while. A stream lasts six hours from the moment it
            opens.
          </span>
        ) : null}
        {chip.isPastByteAllowance ? (
          <span className="meridian-composer-attachment__note">
            Past this deployment&apos;s per-attachment size. The upload is still attempted — the
            daemon decides.
          </span>
        ) : null}
        {chip.offersRetry ? (
          <button
            type="button"
            className="meridian-composer-attachment__act"
            onClick={() => {
              props.onRetry(chip.localId);
            }}
          >
            Retry
          </button>
        ) : null}
        {chip.offersAbandon ? (
          <button
            type="button"
            className="meridian-composer-attachment__act"
            onClick={() => {
              props.onAbandon(chip.localId);
            }}
          >
            Cancel
          </button>
        ) : null}
      </span>
      {chip.refusal === undefined ? null : (
        <>
          <InlineRefusal code={chip.refusal.code} detail={chip.refusal.detail} />
          {/* WHAT TO DO NEXT, AS TEXT. Rule 4's third clause travelled on the retry
              control's `title` and the cancel control's — a tooltip a touch user never
              sees, a keyboard user reaches only by hovering with a pointer they are
              not using, and a screen-reader user meets only where the platform is
              configured to announce one. The remedy is the one line on a refused row
              that names an act; it renders like the run-interventions remedy does. */}
          {chip.refusal.disposition === undefined ? null : (
            <p className="meridian-composer-attachment__remedy">{chip.refusal.disposition}</p>
          )}
        </>
      )}
      {/* And the consequence of the control that is still offered. It says what
          abandoning DOES — client-side, with the daemon's reaper claiming the spool —
          rather than promising a reclaim nothing performs. */}
      {chip.offersAbandon ? (
        <p className="meridian-composer-attachment__remedy">{chip.abandonCopy}</p>
      ) : null}
    </li>
  );
}
