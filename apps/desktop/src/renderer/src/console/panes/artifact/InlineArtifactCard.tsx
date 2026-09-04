// The published-artifact card a ledger row carries, and the seat registration that
// fills it.
//
// `Spec-023 §Console Design (Meridian)` rule 7 puts diffs, attachments, and published
// artifacts in the timeline as cards inside the row that produced them, because they
// BELONG to that turn — a person reading a conversation should not have to leave it to
// see what it made.
//
// TWO FAMILIES MEET AT THE SEAT AND NEITHER IMPORTS THE OTHER. The ledger (T-023p-1C-2)
// renders the seat; this family owns the body. The registration below is the whole
// contact surface, and it is called from the repos family's own door rather than at
// this module's scope, for that door's reason: one module knows every body the family
// owns, and a hot reload re-runs one module rather than several.
//
// WHAT THE SEAT HANDS OVER, AND WHAT IT CANNOT. `ArtifactInlineCardProps` carries a
// `ConsoleEntityRef` and no manifest, because the read that would fetch one —
// `ArtifactRead` — has no method string registered anywhere and reaches the console
// only through `bridge/growth-port.ts`, which refuses by name against the
// `artifact-ingest-and-crud` slate row. The seat additionally hands over no bridge, so
// this body cannot even attempt the call: it renders the identity it was given and the
// absence that says nobody asked. The `manifest` prop is the seam the row lands on the
// day both exist.
//
// THE ABSENCE IS `not-checked` AND NEVER `empty`. `empty` here would be the console
// stating that the turn produced no artifact — a fact the ledger row already
// contradicts by carrying this card at all.

import { useId } from "react";

import {
  Chip,
  DerivedFigure,
  Glyph,
  Nothing,
  WireFigure,
  formatByteQuantity,
} from "../../primitives/index.js";
import type { ArtifactManifestRow } from "../../repos/artifact-model.js";
import {
  ARTIFACT_STATE_PRESENTATION,
  ARTIFACT_VISIBILITY_PRESENTATION,
  artifactProducerLabel,
  artifactReplicationPresentation,
} from "../../repos/artifact-model.js";
import { registerInlineCardBody, type ArtifactInlineCardProps } from "../../seats/index.js";

/** Who owns this body, for the seat registry's owner-scoped duplicate policy. */
const INLINE_ARTIFACT_CARD_OWNER = "repos";

/** Glyph edge length in the card's chrome, matching the primitives' inline size. */
const INLINE_ARTIFACT_CARD_GLYPH_SIZE = 12;

export interface InlineArtifactCardProps {
  readonly card: ArtifactInlineCardProps;
  /** The manifest row to render. Absent until a wire produces one — see the header. */
  readonly manifest?: ArtifactManifestRow;
}

export function InlineArtifactCard(props: InlineArtifactCardProps): React.JSX.Element {
  const headingId = useId();
  const { manifest } = props;
  return (
    <section className="meridian-artifact-card" aria-labelledby={headingId}>
      <header className="meridian-artifact-card__header">
        <h4 className="meridian-artifact-card__heading" id={headingId}>
          <Glyph name="artifact" size={INLINE_ARTIFACT_CARD_GLYPH_SIZE} />
          Artifact
        </h4>
        {/* Wire-verbatim, with the full string recoverable through the title: an
            artifact id is how a participant reaches this row anywhere else in the
            product, so a truncated one that could not be read back would be useless. */}
        <span className="meridian-artifact-card__id" title={props.card.artifact.id}>
          {props.card.artifact.id}
        </span>
      </header>
      <div className="meridian-artifact-card__body">
        {manifest === undefined ? (
          <Nothing
            kind="not-checked"
            placement="inline"
            title="This artifact has not been read."
            detail="The turn named it and the read that fetches its manifest is not registered on the bridge yet, so nothing has been asked for and nothing is being reported as missing."
          />
        ) : (
          <div className="meridian-artifact-card__face">
            <Chip label={manifest.artifactType} mono />
            <Chip
              tone={ARTIFACT_STATE_PRESENTATION[manifest.state].tone}
              label={manifest.state}
              mono
            />
            <Chip
              tone={ARTIFACT_VISIBILITY_PRESENTATION[manifest.visibility].tone}
              label={manifest.visibility}
              mono
            />
            <WireFigure
              value={formatByteQuantity(manifest.size).text}
              title={String(manifest.size)}
            />
            <DerivedFigure text={`by ${artifactProducerLabel(manifest)}`} />
            <DerivedFigure text={artifactReplicationPresentation(manifest).meaning} />
          </div>
        )}
      </div>
    </section>
  );
}

/** Fill the ledger's `artifact` card seat. Called from the repos family's own door. */
export function registerInlineArtifactCardBody(): void {
  registerInlineCardBody("artifact", {
    owner: INLINE_ARTIFACT_CARD_OWNER,
    render: (cardProps) => <InlineArtifactCard card={cardProps} />,
  });
}
