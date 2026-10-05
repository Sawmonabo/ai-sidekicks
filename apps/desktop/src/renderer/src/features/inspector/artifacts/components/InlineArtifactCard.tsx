// The published-artifact card a transcript row carries.
//
// The inline card registry hands over an `EntityRef`, no manifest or bridge, so this body
// makes no read: it renders the identity it was given, and the manifest row when the caller
// has one.

import "./inline-artifact-card.css";

import { useId } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { type ArtifactManifestRow } from "../model.js";
import { ARTIFACT_STATE_TONES, artifactProducerLabel } from "../copy.js";
import type { ArtifactInlineCardProps } from "#renderer/registries/inline-cards/inline-card-registry.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";

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
        {/* Wire-verbatim; the title keeps the full string since the id is how a user finds the
            artifact elsewhere. */}
        <span className="meridian-artifact-card__id" title={props.card.artifact.id}>
          {props.card.artifact.id}
        </span>
      </header>
      {manifest === undefined ? null : (
        <div className="meridian-artifact-card__body">
          <div className="meridian-artifact-card__face">
            <Chip label={manifest.artifactType} mono />
            <Chip tone={ARTIFACT_STATE_TONES[manifest.state]} label={manifest.state} mono />
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
