// The published-artifact card a ledger row carries, and the seat registration that fills it.
//
// Diffs, attachments and published artifacts go in the timeline as cards inside the row
// that produced them, because they belong to that turn.
//
// Two families meet at the seat and neither imports the other: the ledger renders the seat
// and this family owns the body. The registration is called from the repos family's own
// door rather than at this module's scope, so a hot reload re-runs one module.
//
// The seat hands over a `ConsoleEntityRef` and no manifest or bridge, so this body makes no
// read: it renders the identity it was given, and the manifest row when its caller has one.

import { useId } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  WireFigure,
  formatByteQuantity,
} from "@renderer/console/primitives/index.js";
import { type ArtifactManifestRow } from "../artifact-model.js";
import { ARTIFACT_STATE_PRESENTATION, artifactProducerLabel } from "../artifact-copy.js";
import type {
  InlineCardSeatRegistry,
  ArtifactInlineCardProps,
} from "@renderer/console/seats/index.js";
import { GLYPH_SIZE_ROW } from "@renderer/styles/glyphs.js";

/** Who owns this body, for the seat registry's owner-scoped duplicate policy. */
const INLINE_ARTIFACT_CARD_OWNER = "repos";

/** What the inline artifact card is given. */
export interface InlineArtifactCardProps {
  readonly card: ArtifactInlineCardProps;
  /** The manifest row to render. The card draws no body without one. */
  readonly manifest?: ArtifactManifestRow;
}

/** The card: the artifact's identity, and its manifest face when a row is supplied. */
export function InlineArtifactCard(props: InlineArtifactCardProps): React.JSX.Element {
  const headingId = useId();
  const { manifest } = props;
  return (
    <section className="meridian-artifact-card" aria-labelledby={headingId}>
      <header className="meridian-artifact-card__header">
        <h4 className="meridian-artifact-card__heading" id={headingId}>
          <Glyph name="artifact" size={GLYPH_SIZE_ROW} />
          Artifact
        </h4>
        {/* Wire-verbatim, with the full string recoverable through the title, because an
            artifact id is how a user reaches this row anywhere else in the product. */}
        <span className="meridian-artifact-card__id" title={props.card.artifact.id}>
          {props.card.artifact.id}
        </span>
      </header>
      {manifest === undefined ? null : (
        <div className="meridian-artifact-card__body">
          <div className="meridian-artifact-card__face">
            <Chip label={manifest.artifactType} mono />
            <Chip
              tone={ARTIFACT_STATE_PRESENTATION[manifest.state].tone}
              label={manifest.state}
              mono
            />
            <WireFigure
              value={formatByteQuantity(manifest.size).text}
              title={String(manifest.size)}
            />
            <DerivedFigure text={`by ${artifactProducerLabel(manifest)}`} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Fill the ledger's `artifact` card seat on the board the family's own door supplies. */
export function registerInlineArtifactCardBody(seats: InlineCardSeatRegistry): void {
  seats.register("artifact", {
    owner: INLINE_ARTIFACT_CARD_OWNER,
    render: (cardProps) => <InlineArtifactCard card={cardProps} />,
  });
}
