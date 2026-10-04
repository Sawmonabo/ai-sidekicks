// The artifacts panel: what this session produced, and the manifest re-read a user may attempt
// on one.
//
// It renders and does not read, and never renders a payload. A count is a reading, so the
// head figure and the filter counts render on the `listed` arm alone.

import "./artifacts.css";

import { useMemo, useState } from "react";

import { GLYPH_SIZE_CHROME } from "@renderer/styles/glyphs.js";
import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { Glyph } from "@renderer/components/Glyph/Glyph.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
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

/** The artifacts panel's state and the re-read wiring. */
export interface ArtifactsSectionProps {
  readonly state: ArtifactsSectionState;
  /** The instant the section read at; ages move when it re-reads, never on a timer. */
  readonly nowMilliseconds: number;
  /**
   * Re-read one row's manifest.
   *
   * Named for the manifest-only request it sends; "fetch payload" would promise a download.
   */
  readonly onReadManifest?: ((row: ArtifactManifestRow) => void) | undefined;
  /**
   * The rows whose manifest re-read is on the wire, so each one's control holds.
   *
   * The mounting view's set, not a second copy. Absent means the section performs no re-read.
   */
  readonly manifestReadInFlightArtifactIds?: ReadonlySet<string> | undefined;
}

/** One shared empty list, so the memos below see a stable reference on the row-less arms. */
const NO_ROWS: readonly ArtifactManifestRow[] = [];

/** The session's artifacts: a head count, a type filter, and one row per manifest. */
export function ArtifactsSection(props: ArtifactsSectionProps): React.JSX.Element {
  const [typeFilter, setTypeFilter] = useState<ArtifactTypeFilter>(ARTIFACT_TYPE_FILTER_ALL);

  // Absent on every arm but `listed`; `NO_ROWS` only keeps the memo inputs stable.
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
        Every type is offered, including the ones at zero. The group is absent until a list
        has answered: an offered filter promises that pressing it narrows something.
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
 * The panel's arms; each empty state is its own kind.
 *
 * The session-empty copy is gated on what the read returned, so a filter that matches
 * nothing never tells a session holding artifacts it has none.
 */
function renderPanelBody(
  props: ArtifactsSectionProps,
  visibleRows: readonly ArtifactManifestRow[],
  typeFilter: ArtifactTypeFilter,
): React.JSX.Element {
  if (props.state.kind === "loading") {
    return <Nothing kind="not-loaded" placement="block" title="Reading this session's artifacts" />;
  }
  if (props.state.rows.length === 0) {
    return <Nothing kind="empty" placement="block" title="Nothing made here yet." />;
  }
  if (visibleRows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="block"
        title="No artifacts of the type this filter is set to."
        detail={
          `This session holds ${formatCount(props.state.rows.length)} of ` +
          "other types. Every type is on the filter above with its own " +
          "count."
        }
        // The type is a wire word, so it renders through `WireFigure`, not prose.
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

/** The type filter buttons: every type plus the one that selects all. */
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
