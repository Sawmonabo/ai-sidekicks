// One artifact manifest row: the six figures on its face, its acts, and its
// disclosure.
//
// Split out of `ArtifactsPanel.tsx` at the seam the panel actually has. The panel
// owns the session-scoped surface — the head count, the type filter, the delete
// receipt, and which absence the body renders — while everything below is scoped to
// ONE manifest and needs nothing the panel knows. The class names are unchanged,
// because moving a body is not a redesign of it.
//
// THE THREE RULES THE PANEL STATES ARE ENFORCED HERE, because this is where the
// markup is. No element in this file can hold a payload; nothing here decides who
// may act, so every control is offered and the daemon's typed refusal renders
// beside the one that was pressed; and the delete confirm states the foreclosure
// consequence before the act, in place.

import type { ConsoleRefusal } from "../../core/index.js";
import {
  Chip,
  DerivedFigure,
  InlineRefusal,
  Nothing,
  WireFigure,
  formatByteQuantity,
  formatRelativeTime,
} from "../../primitives/index.js";
import { type ArtifactManifestRow } from "./artifact-model.js";
import {
  ARTIFACT_DELETE_CONSEQUENCE,
  ARTIFACT_STATE_PRESENTATION,
  ARTIFACT_VISIBILITY_PRESENTATION,
  artifactProducerLabel,
  artifactReplicationPresentation,
} from "./artifact-copy.js";

/**
 * The two pieces of confirm state one row's controls need.
 *
 * It travels with the row rather than living on the panel, because the panel holds
 * it for exactly one reason: only one row may be awaiting confirmation at a time,
 * which is a property of the LIST and not of any row in it.
 */
export interface DeleteConfirmState {
  readonly artifactIdAwaitingDeleteConfirm: string | undefined;
  readonly setArtifactIdAwaitingDeleteConfirm: (artifactId: string | undefined) => void;
}

export interface ArtifactRowProps {
  readonly row: ArtifactManifestRow;
  /** The instant the row was rendered against. Ages move when the surface re-reads. */
  readonly nowMilliseconds: number;
  /** What the last act on THIS row answered. Refusals only; absent means none. */
  readonly refusal?: ConsoleRefusal | undefined;
  /** Whether this row's manifest re-read is on the wire. Holds the control that sent it. */
  readonly isManifestReadInFlight?: boolean | undefined;
  readonly onReadManifest?: ((row: ArtifactManifestRow) => void) | undefined;
  readonly onChangeVisibility?: ((row: ArtifactManifestRow) => void) | undefined;
  readonly onDelete?: ((row: ArtifactManifestRow) => void) | undefined;
  readonly confirmState: DeleteConfirmState;
}

export function ArtifactRow(props: ArtifactRowProps): React.JSX.Element {
  const { row, refusal, confirmState } = props;
  const statePresentation = ARTIFACT_STATE_PRESENTATION[row.state];
  const visibilityPresentation = ARTIFACT_VISIBILITY_PRESENTATION[row.visibility];
  const replicationPresentation = artifactReplicationPresentation(row);
  const formattedSize = formatByteQuantity(row.size);
  const isAwaitingConfirm = confirmState.artifactIdAwaitingDeleteConfirm === row.id;

  return (
    <article className="meridian-artifact-row" aria-label={`Artifact ${row.id}`}>
      <div className="meridian-artifact-row__face">
        <Chip
          label={row.artifactType}
          mono
          glyph={row.artifactType === "diff" ? "diff" : "artifact"}
        />
        <Chip tone={statePresentation.tone} label={row.state} mono />
        <Chip tone={visibilityPresentation.tone} label={row.visibility} mono />
        <span className="meridian-artifact-row__size">
          {/* The scaled reading, with the exact byte count the daemon sent on its title. */}
          <WireFigure value={formattedSize.text} title={`${row.size}`} />
        </span>
        <span className="meridian-artifact-row__producer">
          by <DerivedFigure text={artifactProducerLabel(row)} />
        </span>
        <span className="meridian-artifact-row__age" title={row.createdAt}>
          <DerivedFigure text={formatRelativeTime(row.createdAt, props.nowMilliseconds)} />
        </span>
      </div>

      <p className="meridian-artifact-row__replication">{replicationPresentation.meaning}</p>

      <div className="meridian-artifact-row__acts">
        {props.onReadManifest === undefined ? null : (
          <button
            type="button"
            className="meridian-artifact-row__act meridian-artifact-row__act--primary"
            onClick={() => props.onReadManifest?.(row)}
            // HELD WHILE THIS ROW'S RE-READ IS OUTSTANDING, and the surface's own
            // register is what holds it — there is no second flag to keep in step. Two
            // reads of one manifest settle in either order, so the second press is a
            // press whose answer could be the staler row; the acts refuse it in words,
            // and this is what keeps a participant from meeting that refusal by
            // pressing a control the panel was offering.
            disabled={props.isManifestReadInFlight ?? false}
          >
            Read manifest
          </button>
        )}
        {props.onChangeVisibility === undefined ? null : (
          <button
            type="button"
            className="meridian-artifact-row__act"
            onClick={() => props.onChangeVisibility?.(row)}
          >
            {row.visibility === "shared" ? "Make local-only" : "Share with the session"}
          </button>
        )}
        {props.onDelete === undefined || isAwaitingConfirm ? null : (
          <button
            type="button"
            className="meridian-artifact-row__act"
            onClick={() => confirmState.setArtifactIdAwaitingDeleteConfirm(row.id)}
          >
            Delete
          </button>
        )}
      </div>

      {props.onDelete === undefined || !isAwaitingConfirm ? null : (
        <div className="meridian-artifact-row__confirm" role="group" aria-label="Confirm delete">
          <p className="meridian-artifact-row__consequence">{ARTIFACT_DELETE_CONSEQUENCE}</p>
          <button
            type="button"
            className="meridian-artifact-row__act meridian-artifact-row__act--destructive"
            onClick={() => {
              confirmState.setArtifactIdAwaitingDeleteConfirm(undefined);
              props.onDelete?.(row);
            }}
          >
            Delete permanently
          </button>
          <button
            type="button"
            className="meridian-artifact-row__act"
            onClick={() => confirmState.setArtifactIdAwaitingDeleteConfirm(undefined)}
          >
            Keep it
          </button>
        </div>
      )}

      {refusal === undefined ? null : (
        // Inline, beside the controls that produced it, and the controls stay: the
        // act did not happen and the participant may try another one. The daemon's
        // own sentence is what renders — a blocked delete's remedy (delete the
        // derivatives first, or keep the source) is the daemon's to state.
        <InlineRefusal code={refusal.code} detail={refusal.detail} />
      )}

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
