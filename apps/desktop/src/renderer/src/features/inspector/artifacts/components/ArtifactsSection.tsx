// The artifacts panel: what this session produced, and the manifest re-read a user may
// attempt on one.
//
// It renders and does not read: the state arrives as a prop. It never renders a payload;
// its one act is a manifest re-read, named for what comes back ("Read manifest"). The
// payload has one home in this family, `repos/artifact-pane/`.
//
// A count is a reading, so only a read may put one on screen. The head figure and the
// filter counts are derived from the rows a list answered with and render on the `listed`
// arm alone; while a read is in flight the head is the heading with no figure beside it,
// and the body's absence card is the whole reading. This module is the session-scoped
// surface; one manifest's face, act and disclosure are `ArtifactRow.tsx`.

import "./artifacts.css";

import { useMemo, useState } from "react";

import { GLYPH_SIZE_CHROME } from "@renderer/styles/glyphs.js";
import {
  DerivedFigure,
  Glyph,
  Nothing,
  WireFigure,
  formatCount,
} from "@renderer/console/primitives/index.js";
import { ArtifactRow } from "./ArtifactRow.js";
import {
  ARTIFACT_FILTER_TYPES,
  ARTIFACT_TYPE_FILTER_ALL,
  artifactTypeCounts,
  filterArtifactRows,
  type ArtifactManifestRow,
  type ArtifactType,
  type ArtifactTypeFilter,
  type ArtifactsSectionState,
} from "../artifact-model.js";

export interface ArtifactsSectionProps {
  readonly state: ArtifactsSectionState;
  /** The instant the surface read at. Ages move when it re-reads and never on a timer. */
  readonly nowMilliseconds: number;
  /**
   * Re-read one row's manifest.
   *
   * Named for what this panel asks for: it sends the manifest-only request, so a control
   * called "fetch payload" here would promise a download it does not perform.
   */
  readonly onReadManifest?: ((row: ArtifactManifestRow) => void) | undefined;
  /**
   * The rows whose manifest re-read is on the wire, so each one's control holds.
   *
   * The mounting surface's register and never a second copy: a re-read is single-flight
   * per row, so a control offered while that row's call is outstanding would send a
   * second read. Absent means the surface performs no re-read at all.
   */
  readonly manifestReadInFlightArtifactIds?: ReadonlySet<string> | undefined;
}

/** One shared empty list, so the memos below see a stable reference on the row-less arms. */
const NO_ROWS: readonly ArtifactManifestRow[] = [];

/** The session's artifacts: a head count, a type filter, and one row per manifest. */
export function ArtifactsSection(props: ArtifactsSectionProps): React.JSX.Element {
  const [typeFilter, setTypeFilter] = useState<ArtifactTypeFilter>(ARTIFACT_TYPE_FILTER_ALL);

  // Absent on every arm but `listed`, and that is what the head and the filter group are
  // gated on. `NO_ROWS` only keeps the memo inputs stable; it feeds no figure.
  const listedRows = props.state.kind === "listed" ? props.state.rows : undefined;
  const rows = listedRows ?? NO_ROWS;
  const countsByType = useMemo(() => artifactTypeCounts(rows), [rows]);
  const visibleRows = useMemo(() => filterArtifactRows(rows, typeFilter), [rows, typeFilter]);

  return (
    <section className="meridian-artifacts" aria-label="Artifacts">
      <header className="meridian-artifacts__head">
        <h3 className="meridian-artifacts__heading">
          <Glyph name="artifact" size={GLYPH_SIZE_CHROME} />
          Artifacts
        </h3>
        {listedRows === undefined ? null : (
          <DerivedFigure text={`${formatCount(listedRows.length)} in this session`} />
        )}
      </header>

      {/*
        Every type is offered, including the ones at zero: six types are one filter over
        one list, and hiding an empty option would hide the vocabulary exactly when
        somebody is looking for something that is not in it.

        The whole group is absent until a list has answered, though: an offered filter is
        a promise that pressing it narrows something, and there is no list yet.
      */}
      {listedRows === undefined ? null : (
        <div
          className="meridian-artifacts__filter"
          role="group"
          aria-label="Filter by artifact type"
        >
          {renderFilterButtons({
            countsByType,
            totalCount: listedRows.length,
            selected: typeFilter,
            onSelect: setTypeFilter,
          })}
        </div>
      )}

      <div className="meridian-artifacts__body">
        {renderPanelBody(props, visibleRows, typeFilter)}
      </div>
    </section>
  );
}

/**
 * The panel's arms. Each absence is its own kind; none stands in for another.
 *
 * The two empties are different claims, and the read decides which. The session-empty
 * copy is gated on what the read returned, so a session holding six artifacts is never
 * told it has none because a filter type matched nothing. The filter's own empty names
 * the type it is set to and the count it is hiding.
 */
function renderPanelBody(
  props: ArtifactsSectionProps,
  visibleRows: readonly ArtifactManifestRow[],
  typeFilter: ArtifactTypeFilter,
): React.JSX.Element {
  if (props.state.kind === "loading") {
    return (
      <Nothing kind="not-loaded" placement="surface" title="Reading this session's artifacts" />
    );
  }
  if (props.state.rows.length === 0) {
    return <Nothing kind="empty" placement="surface" title="Nothing made here yet." />;
  }
  if (visibleRows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No artifacts of the type this filter is set to."
        detail={`This session holds ${formatCount(props.state.rows.length)} of other types. Every type is on the filter above with its own count.`}
        // The type is a wire word, so it renders through `WireFigure` rather than as
        // prose interpolated into the copy above.
        action={<WireFigure value={typeFilter} />}
      />
    );
  }
  return (
    <ul className="meridian-artifacts__list">
      {visibleRows.map((row) => (
        <li key={row.id}>
          <ArtifactRow
            row={row}
            nowMilliseconds={props.nowMilliseconds}
            isManifestReadInFlight={props.manifestReadInFlightArtifactIds?.has(row.id) ?? false}
            onReadManifest={props.onReadManifest}
          />
        </li>
      ))}
    </ul>
  );
}

interface FilterButtonsProps {
  readonly countsByType: Readonly<Record<ArtifactType, number>>;
  readonly totalCount: number;
  readonly selected: ArtifactTypeFilter;
  readonly onSelect: (filter: ArtifactTypeFilter) => void;
}

/**
 * The seven filter buttons: every type, plus the one that selects them all. A render
 * helper rather than a component, because it holds no state and takes no hooks.
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
      {ARTIFACT_FILTER_TYPES.map((artifactType) => (
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
