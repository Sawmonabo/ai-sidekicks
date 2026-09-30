// One artifact manifest row: the figures on its face, its manifest re-read, and its
// disclosure. Everything here is scoped to one manifest, and no element can hold a payload.

import { Chip } from "@renderer/components/Chip/Chip.js";
import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatByteQuantity, formatRelativeTime } from "@renderer/lib/wire-figures.js";
import { type ArtifactManifestRow } from "../artifact-model.js";
import { ARTIFACT_STATE_PRESENTATION, artifactProducerLabel } from "../artifact-copy.js";

/** What one manifest row renders and the re-read it may offer. */
export interface ArtifactRowProps {
  readonly row: ArtifactManifestRow;
  /** The instant the row was rendered against; ages move only when the section re-reads. */
  readonly nowMilliseconds: number;
  /** Whether this row's manifest re-read is on the wire; holds the control that sent it. */
  readonly isManifestReadInFlight?: boolean | undefined;
  /** Re-read this row's manifest. Absent means the section offers no re-read. */
  readonly onReadManifest?: ((row: ArtifactManifestRow) => void) | undefined;
}

/** One manifest row, with its face, its re-read control and its digest and metadata. */
export function ArtifactRow(props: ArtifactRowProps): React.JSX.Element {
  const { row } = props;
  const statePresentation = ARTIFACT_STATE_PRESENTATION[row.state];
  const formattedSize = formatByteQuantity(row.size);

  return (
    <article className="meridian-artifact-row" aria-label={`Artifact ${row.id}`}>
      <div className="meridian-artifact-row__face">
        <Chip
          label={row.artifactType}
          mono
          glyph={row.artifactType === "diff" ? "diff" : "artifact"}
        />
        <Chip tone={statePresentation.tone} label={row.state} mono />
        <span className="meridian-artifact-row__size">
          {/* The title keeps the exact byte count the daemon sent. */}
          <WireFigure value={formattedSize.text} title={`${row.size}`} />
        </span>
        <span className="meridian-artifact-row__producer">
          by <DerivedFigure text={artifactProducerLabel(row)} />
        </span>
        <span className="meridian-artifact-row__age" title={row.createdAt}>
          <DerivedFigure text={formatRelativeTime(row.createdAt, props.nowMilliseconds)} />
        </span>
      </div>

      <div className="meridian-artifact-row__acts">
        {props.onReadManifest === undefined ? null : (
          <button
            type="button"
            className="meridian-artifact-row__act meridian-artifact-row__act--primary"
            onClick={() => props.onReadManifest?.(row)}
            // Two reads of one manifest settle in either order; a second press could bring
            // back the staler row.
            disabled={props.isManifestReadInFlight ?? false}
          >
            Read manifest
          </button>
        )}
      </div>

      <details className="meridian-artifact-row__detail">
        <summary className="meridian-artifact-row__detail-summary">Digest and metadata</summary>
        <dl className="meridian-artifact-row__detail-list">
          <div className="meridian-artifact-row__pair">
            <dt>Digest</dt>
            <dd>
              <WireFigure value={row.digest} />
            </dd>
          </div>
          <div className="meridian-artifact-row__pair">
            <dt>Derived from</dt>
            <dd>
              {row.subject === undefined ? (
                <Nothing kind="empty" placement="inline" title="Not a derivative." />
              ) : (
                <WireFigure value={row.subject} />
              )}
            </dd>
          </div>
          <div className="meridian-artifact-row__pair">
            <dt>Run</dt>
            <dd>
              {row.runId === undefined ? (
                <Nothing kind="empty" placement="inline" title="No run produced this." />
              ) : (
                <WireFigure value={row.runId} />
              )}
            </dd>
          </div>
          {renderStringMap("Annotations", row.annotations)}
          {renderStringMap("Metadata", row.metadata)}
        </dl>
      </details>
    </article>
  );
}

/** One free-form wire map, drawn as pairs. Keys and values are both the wire's. */
function renderStringMap(
  label: string,
  entries: Readonly<Record<string, string>>,
): React.JSX.Element {
  const entryPairs = Object.entries(entries);
  return (
    <div className="meridian-artifact-row__pair">
      <dt>{label}</dt>
      <dd>
        {entryPairs.length === 0 ? (
          <Nothing kind="empty" placement="inline" title="None." />
        ) : (
          <ul className="meridian-artifact-row__map">
            {entryPairs.map(([entryKey, entryValue]) => (
              <li key={entryKey}>
                <WireFigure value={entryKey} />
                <WireFigure value={entryValue} />
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  );
}
