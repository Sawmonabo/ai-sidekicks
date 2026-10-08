// The published-artifact card a transcript row carries.
//
// The inline card registry hands over an `EntityRef`, no manifest or bridge, so this body
// makes no read: it renders the identity it was given, and the manifest row when the caller
// has one.

import "./InlineArtifactCard.css";

import { useId } from "react";

import { Chip } from "#renderer/components/Chip/Chip.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { WireFigure } from "#renderer/components/WireFigure/WireFigure.js";
import { codeWords } from "#renderer/lib/code-words.js";
import { formatByteQuantity } from "#renderer/lib/wire/figures.js";
import { type ArtifactManifestRow } from "../model.js";
import { ARTIFACT_STATE_TONES } from "../copy.js";
import type { ArtifactInlineCardProps } from "#renderer/registries/inline-cards/registry.js";
import { GLYPH_SIZE_ROW } from "#renderer/styles/glyphs.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

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
        {/* Wire-verbatim; the hover label keeps the full string since the id is how a user finds
            the artifact elsewhere. */}
        <HoverLabel text={props.card.artifact.id} textIs="visible-text">
          <span className="meridian-artifact-card__id">{props.card.artifact.id}</span>
        </HoverLabel>
      </header>
      {manifest === undefined ? null : (
        <div className="meridian-artifact-card__body">
          <div className="meridian-artifact-card__face">
            <Chip label={codeWords(manifest.artifactType)} />
            <Chip tone={ARTIFACT_STATE_TONES[manifest.state]} label={codeWords(manifest.state)} />
            <WireFigure
              value={formatByteQuantity(manifest.size).text}
              title={String(manifest.size)}
            />
          </div>
        </div>
      )}
    </section>
  );
}
