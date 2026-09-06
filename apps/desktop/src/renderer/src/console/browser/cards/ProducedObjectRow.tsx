// One produced object, as the LOG knows it — the shelf's other row shape.
//
// Its own module because `apps/desktop/AGENTS.md` gives a `.tsx` file one component,
// and the split is the rule earning its keep here rather than a formality: this row
// and the capture card are two DIFFERENT claims about an object — what the log said,
// and what the act that made it answered with — and a reader looking for either one
// finds it by its own name.
//
// `Spec-023 §Console Design (Meridian)` 12.6 Density: "One artifact row per produced
// object, collapsed to name, kind, and size, with the preview one click away." Name,
// kind, and size live on the artifact manifest, which the console reads through an
// operation the growth port refuses today — so this row renders what the log actually
// carries and says plainly that the rest is unread, rather than putting the artifact
// id where a name belongs and teaching a person to read a locator as a name.

import { Chip, Nothing, WireFigure } from "../../primitives/index.js";
import type { ProducedArtifact, ProducedArtifactState } from "./produced-objects.js";

/** How each state reads on a row. Total over the set by construction. */
const PRODUCED_STATE_LABELS: Readonly<Record<ProducedArtifactState, string>> = {
  pending: "Ingest in flight",
  published: "Stored",
  superseded: "Superseded",
};

/**
 * One produced object, as the log knows it.
 *
 * Identity through the wire-figure chokepoint, because an artifact id is a wire value
 * and reads as one everywhere else in the console; the state as a chip, because it is
 * the one thing about the row a person scans for; and the run where the beat named
 * one, because ownership is by run and a shelf that hid it would present four agents'
 * work as one pile.
 */
export function ProducedObjectRow(props: {
  readonly artifact: ProducedArtifact;
}): React.JSX.Element {
  const { artifact } = props;
  return (
    <article className="meridian-browser-card meridian-browser-card--identity">
      <div className="meridian-browser-card__head">
        <WireFigure value={artifact.artifactId} />
        <div className="meridian-browser-card__meta">
          <Chip label={PRODUCED_STATE_LABELS[artifact.state]} glyph="artifact" />
          {artifact.visibility === undefined ? null : <Chip mono label={artifact.visibility} />}
        </div>
      </div>
      {artifact.runId === undefined ? null : (
        <p className="meridian-browser-card__note">
          Produced by run <WireFigure value={artifact.runId} />.
        </p>
      )}
      <Nothing
        kind="not-checked"
        placement="inline"
        title="Manifest not read"
        detail="This object's name, kind, and size are on its manifest, and the console has not read one for it."
      />
    </article>
  );
}
