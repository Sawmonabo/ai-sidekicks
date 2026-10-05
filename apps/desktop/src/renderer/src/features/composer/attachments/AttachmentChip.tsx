// One attachment on one line beside the message it rides with: name, type, size and inline
// progress, so a staged list does not push the message input off the screen. The words come from
// `composer-attachment-chip.ts`, so the chip and the transcript card describe an upload alike.
// The chip's × is client-side abandonment with the daemon's reaper claiming the spool, and the
// line under it says so rather than promising an instant reclaim.

import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { InlineRefusal } from "#renderer/components/Refusal/InlineRefusal.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import type { ComposerAttachmentChipModel } from "./composer-attachment-chip.js";

/** One chip model with the retry and abandon acts, keyed by the entry's local id. */
export interface AttachmentChipProps {
  readonly chip: ComposerAttachmentChipModel;
  readonly onRetry: (localId: string) => void;
  readonly onAbandon: (localId: string) => void;
}

/** One staged attachment as a single-line list item. */
export function AttachmentChip(props: AttachmentChipProps): React.JSX.Element {
  const { chip } = props;
  return (
    <li className="meridian-composer-attachment" aria-label={`Attachment ${chip.name}`}>
      <span className="meridian-composer-attachment__line">
        {/* A declared name is the caller's claim, drawn as a derived figure, not a wire string. */}
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
          // Named for the file it measures so several bars announce distinctly.
          <progress
            className="meridian-composer-attachment__progress"
            max={1}
            value={chip.progressFraction}
            aria-label={`Upload progress for ${chip.name}`}
          />
        )}
        {chip.isStalled ? (
          <span className="meridian-composer-attachment__note">
            No chunk has been acknowledged for a while.
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
            aria-label={`Remove ${chip.name}`}
            onClick={() => {
              props.onAbandon(chip.localId);
            }}
          >
            <Glyph name="close" size={GLYPH_SIZE_ROW} />
          </button>
        ) : null}
      </span>
      {chip.refusal === undefined ? null : (
        <>
          <InlineRefusal code={chip.refusal.code} detail={chip.refusal.detail} />
          {/* Remedy as text, not a `title`: a tooltip is unseen by touch users and announced
              unreliably by assistive technology. */}
          {chip.refusal.disposition === undefined ? null : (
            <p className="meridian-composer-attachment__remedy">{chip.refusal.disposition}</p>
          )}
        </>
      )}
      {/* The consequence of the control still offered: what abandoning actually does. */}
      {chip.offersAbandon ? (
        <p className="meridian-composer-attachment__remedy">{chip.abandonCopy}</p>
      ) : null}
    </li>
  );
}
