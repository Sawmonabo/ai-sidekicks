// The artifacts panel: what this session produced, whether its bytes are reachable,
// and the acts a participant may attempt on one.
//
// `Spec-023 §Console Design (Meridian)` §10.4. Three things about this file are
// decisions rather than implementation, and each is load-bearing:
//
// 1. IT RENDERS, AND IT DOES NOT READ. The state arrives as a prop, and the four
//    arms of `ArtifactsPanelState` are the four things the surface above can have
//    to say. Every read this panel is a view of — list, fetch, re-classify, delete —
//    is on `Plan-023 §Console growth slate` with no method string registered
//    anywhere, so the read is a growth-port call the mounting surface makes and a
//    refusal is what arrives. A panel that called the port itself would own an
//    effect to render the one arm it already takes as a prop.
//
// 2. THE PAYLOAD IS NEVER RENDERED. Not as markup, not as text, not behind a
//    toggle. Payloads are explicit-fetch downloads with no in-product execution
//    surface, and `image/svg+xml` is absent from the default allow-list precisely
//    because it is the one image type that is also a scriptable document. This is a
//    hard renderer rule, so the affordance is a control that ASKS for the payload
//    and there is no element in this file that could ever hold one.
//
// 3. NOTHING HERE DECIDES WHO MAY ACT. `artifact.delete_forbidden` is a 403 the
//    daemon returns against the session roles — an owner may delete any session
//    artifact, a collaborator only artifacts they produced, a viewer none — and
//    greying a button out would mean holding a second copy of all three. Controls
//    are offered; the typed refusal renders beside the one that was pressed.
//
// THE DELETE CONFIRM IS TWO STEPS, IN PLACE. The design requires the foreclosure
// consequence stated BEFORE the act and reported AFTER it; both halves are here. It
// is an inline strip rather than the modal §10.3 describes, because that modal is
// the retire/dispose consent surface and enumerates an inspection this panel is
// never given — borrowing its shape would imply a preview that does not exist.

import { useMemo, useState } from "react";

import type { ConsoleRefusal } from "../core/index.js";
import {
  Chip,
  DerivedFigure,
  Glyph,
  InlineRefusal,
  Nothing,
  RefusalCard,
  WireFigure,
  formatByteQuantity,
  formatCount,
  formatRelativeTime,
} from "../primitives/index.js";
import {
  ARTIFACT_DELETE_CONSEQUENCE,
  ARTIFACT_PAYLOAD_DISPOSITION_COPY,
  ARTIFACT_STATE_PRESENTATION,
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_FILTER_ALL,
  ARTIFACT_VISIBILITY_PRESENTATION,
  artifactProducerLabel,
  artifactReplicationPresentation,
  artifactTypeCounts,
  filterArtifactRows,
  type ArtifactDeleteReceipt,
  type ArtifactManifestRow,
  type ArtifactTypeFilter,
  type ArtifactsPanelState,
} from "./artifact-model.js";

export interface ArtifactsPanelProps {
  readonly state: ArtifactsPanelState;
  /** The instant the surface read at. Ages move when it re-reads and never on a timer. */
  readonly nowMilliseconds: number;
  /** The refusal the last act on a row produced, keyed by artifact id. */
  readonly rowRefusals?: ReadonlyMap<string, ConsoleRefusal> | undefined;
  /** What the most recent delete reported. The result half of the consequence. */
  readonly lastDeleteReceipt?: ArtifactDeleteReceipt | undefined;
  readonly onFetchPayload?: ((row: ArtifactManifestRow) => void) | undefined;
  readonly onChangeVisibility?: ((row: ArtifactManifestRow) => void) | undefined;
  readonly onDelete?: ((row: ArtifactManifestRow) => void) | undefined;
}

const PANEL_GLYPH_SIZE = 14;

/** One shared empty list, so the memos below see a stable reference on the row-less arms. */
const NO_ROWS: readonly ArtifactManifestRow[] = [];

export function ArtifactsPanel(props: ArtifactsPanelProps): React.JSX.Element {
  const [typeFilter, setTypeFilter] = useState<ArtifactTypeFilter>(ARTIFACT_TYPE_FILTER_ALL);
  const [artifactIdAwaitingDeleteConfirm, setArtifactIdAwaitingDeleteConfirm] = useState<
    string | undefined
  >(undefined);

  const rows = props.state.kind === "listed" ? props.state.rows : NO_ROWS;
  const countsByType = useMemo(() => artifactTypeCounts(rows), [rows]);
  const visibleRows = useMemo(() => filterArtifactRows(rows, typeFilter), [rows, typeFilter]);

  return (
    <section className="meridian-artifacts" aria-label="Artifacts">
      <header className="meridian-artifacts__head">
        <h3 className="meridian-artifacts__heading">
          <Glyph name="artifact" size={PANEL_GLYPH_SIZE} />
          Artifacts
        </h3>
        <DerivedFigure text={`${formatCount(rows.length)} in this session`} />
      </header>

      {/*
        Every type is offered, including the ones at zero. Six types are ONE filter
        over ONE list — the diff pane is a view onto this list rather than a second
        store — so hiding an empty option would hide the vocabulary exactly when
        somebody is looking for something that is not in it.
      */}
      <div className="meridian-artifacts__filter" role="group" aria-label="Filter by artifact type">
        {renderFilterButtons({
          countsByType,
          totalCount: rows.length,
          selected: typeFilter,
          onSelect: setTypeFilter,
        })}
      </div>

      {props.lastDeleteReceipt === undefined ? null : (
        <p className="meridian-artifacts__receipt" role="status">
          <Glyph name="check" size={PANEL_GLYPH_SIZE} />
          {ARTIFACT_PAYLOAD_DISPOSITION_COPY[props.lastDeleteReceipt.payloadDisposition]}{" "}
          {props.lastDeleteReceipt.rePublishForeclosed
            ? "Re-publishing this artifact is now permanently impossible."
            : "Re-publishing is still possible."}
        </p>
      )}

      <div className="meridian-artifacts__body">
        {renderPanelBody(props, visibleRows, {
          artifactIdAwaitingDeleteConfirm,
          setArtifactIdAwaitingDeleteConfirm,
        })}
      </div>
    </section>
  );
}

/** The two pieces of confirm state one row's controls need. */
interface DeleteConfirmState {
  readonly artifactIdAwaitingDeleteConfirm: string | undefined;
  readonly setArtifactIdAwaitingDeleteConfirm: (artifactId: string | undefined) => void;
}

/** The panel's four arms. Each absence is its own kind; none stands in for another. */
function renderPanelBody(
  props: ArtifactsPanelProps,
  visibleRows: readonly ArtifactManifestRow[],
  confirmState: DeleteConfirmState,
): React.JSX.Element {
  if (props.state.kind === "not-checked") {
    return (
      <Nothing
        kind="not-checked"
        placement="surface"
        title="Artifacts have not been read."
        detail="The artifact reads this panel is a view of are not registered on the bridge yet, so nothing has been asked for and nothing is being reported as absent."
      />
    );
  }
  if (props.state.kind === "loading") {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading this session's artifacts" />
    );
  }
  if (props.state.kind === "refused") {
    // A card rather than a banner: the read failing changed nothing about what the
    // room can do, and rule 9 picks the shape by blast radius.
    return <RefusalCard code={props.state.refusal.code} detail={props.state.refusal.detail} />;
  }
  if (visibleRows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No artifacts."
        detail="V1 artifacts are produced by runs and by ingest. There is no renderer control that publishes one."
      />
    );
  }
  return (
    <ul className="meridian-artifacts__list">
      {visibleRows.map((row) => (
        <li key={row.id}>{renderArtifactRow(row, props, confirmState)}</li>
      ))}
    </ul>
  );
}

/** One manifest row: the six figures on its face, its acts, and its disclosure. */
function renderArtifactRow(
  row: ArtifactManifestRow,
  props: ArtifactsPanelProps,
  confirmState: DeleteConfirmState,
): React.JSX.Element {
  const statePresentation = ARTIFACT_STATE_PRESENTATION[row.state];
  const visibilityPresentation = ARTIFACT_VISIBILITY_PRESENTATION[row.visibility];
  const replicationPresentation = artifactReplicationPresentation(row);
  const formattedSize = formatByteQuantity(row.size);
  const refusal = props.rowRefusals?.get(row.id);
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
        {props.onFetchPayload === undefined ? null : (
          <button
            type="button"
            className="meridian-artifact-row__act meridian-artifact-row__act--primary"
            onClick={() => props.onFetchPayload?.(row)}
          >
            Fetch payload
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

interface FilterButtonsProps {
  readonly countsByType: Readonly<Record<(typeof ARTIFACT_TYPES)[number], number>>;
  readonly totalCount: number;
  readonly selected: ArtifactTypeFilter;
  readonly onSelect: (filter: ArtifactTypeFilter) => void;
}

/**
 * The seven filter buttons: every type, plus the one that selects them all. A render
 * helper rather than a second component in this file — it holds no state and takes
 * no hooks, so mounting it as an element type would buy a reconciliation boundary
 * nothing needs.
 */
function renderFilterButtons(props: FilterButtonsProps): React.JSX.Element {
  return (
    <>
      <button
        type="button"
        className="meridian-artifacts__filter-button"
        aria-pressed={props.selected === ARTIFACT_TYPE_FILTER_ALL}
        onClick={() => props.onSelect(ARTIFACT_TYPE_FILTER_ALL)}
      >
        All <DerivedFigure text={formatCount(props.totalCount)} />
      </button>
      {ARTIFACT_TYPES.map((artifactType) => (
        <button
          key={artifactType}
          type="button"
          className="meridian-artifacts__filter-button"
          aria-pressed={props.selected === artifactType}
          onClick={() => props.onSelect(artifactType)}
        >
          <WireFigure value={artifactType} />
          <DerivedFigure text={formatCount(props.countsByType[artifactType])} />
        </button>
      ))}
    </>
  );
}
