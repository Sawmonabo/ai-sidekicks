// The artifacts panel: what this session produced, whether its bytes are reachable,
// and the acts a participant may attempt on one.
//
// THE ARTIFACT SURFACE'S COMPOSITION IS THIS FAMILY'S, because `Spec-023 §Console
// Design (Meridian)` puts a surface's composition — what it renders, offers, refuses,
// and folds — in the console's code. Three things about this file are
// decisions rather than implementation, and each is load-bearing:
//
// 1. IT RENDERS, AND IT DOES NOT READ. The state arrives as a prop, and the four
//    arms of `ArtifactsPanelState` are the four things the surface above can have
//    to say. Every read this panel is a view of — list, fetch, re-classify, delete —
//    is on `Plan-023 §Console growth slate` with no method string registered
//    anywhere, so the read is a growth-port call the mounting surface makes and a
//    refusal is what arrives. A panel that called the port itself would own an
//    effect to render the one arm it already takes as a prop. Each act is named for
//    what its registered reply serves and never for what the wire could one day
//    carry — the manifest re-read is "Read manifest" because that is what comes
//    back.
//
// 2. THIS PANEL NEVER RENDERS A PAYLOAD. Not as markup, not as text, not behind a
//    toggle: it lists manifests, and every act it offers is a manifest act. The
//    payload has one home in this family — `repos/artifact-pane/`, which asks for it
//    through `artifactRead`'s `includePayload` and draws the bytes as text in a
//    `<pre>` — and this panel is deliberately not a second one. Nothing here is ever
//    rendered as markup: `image/svg+xml` is absent from the default allow-list
//    precisely because it is the one image type that is also a scriptable document.
//
// 3. NOTHING HERE DECIDES WHO MAY ACT. `artifact.delete_forbidden` is a 403 the
//    daemon returns against the session roles — an owner may delete any session
//    artifact, a collaborator only artifacts they produced, a viewer none — and
//    greying a button out would mean holding a second copy of all three. Controls
//    are offered; the typed refusal renders beside the one that was pressed.
//
// THE DELETE CONFIRM IS TWO STEPS, IN PLACE. This panel states the foreclosure
// consequence BEFORE the act and reports it AFTER, and both halves ship:
// the consequence strip is on the row and the receipt is here. It is an inline
// strip rather than the retire/dispose modal the execution-root surface would use,
// because that modal enumerates an inspection this panel is never
// given — borrowing its shape would imply a preview that does not exist.
//
// WHAT THIS FILE OWNS, AND WHERE THE REST WENT. This module is the SESSION-scoped
// surface: the head count, the type filter, the delete receipt, and which of the
// body's arms renders. One manifest's face, acts, confirm strip, and disclosure are
// `ArtifactRow.tsx`, which needs nothing this file knows — the split is that seam
// and not a line budget, and no class name moved with it.
//
// A COUNT IS A READING, SO ONLY A READ MAY PUT ONE ON SCREEN. The head figure and the
// seven filter counts are derived from the rows a LIST answered with, and on the three
// arms that carry no rows there is no list: nobody asked, a read is in flight, or one
// was refused. Substituting an empty array for those made the head say "0 in this
// session" and every type report zero — a total the console asserted in its own voice
// while the body directly below it said the list was unknown or had failed. So both
// derivations render on the `listed` arm alone, and on the other three the head is the
// heading with no figure beside it: the body's own absence card is the whole reading,
// and rule 8 forbids a surface answering a question nothing put.

import { useMemo, useState } from "react";

// The wire's own type census, so the filter offers exactly the types the manifest
// envelope declares. Read here rather than through a family-local copy of the list:
// a copy goes on offering a type the wire dropped, with nothing failing.
import { useSubjectScopedState } from "../../store/index.js";
import { GLYPH_SIZE_CHROME } from "../../tokens/index.js";
import { GROWTH_ARTIFACT_TYPES } from "../../bridge/index.js";
import type { ConsoleRefusal } from "../../core/index.js";
import {
  DerivedFigure,
  Glyph,
  Nothing,
  RefusalCard,
  WireFigure,
  formatCount,
} from "../../primitives/index.js";
import { ArtifactRow, type DeleteConfirmState } from "./ArtifactRow.js";
import {
  ARTIFACT_TYPE_FILTER_ALL,
  artifactTypeCounts,
  filterArtifactRows,
  type ArtifactDeleteReceipt,
  type ArtifactManifestRow,
  type ArtifactType,
  type ArtifactTypeFilter,
  type ArtifactsPanelState,
} from "./artifact-model.js";
import { artifactDeleteReceiptSentence } from "./artifact-copy.js";

export interface ArtifactsPanelProps {
  readonly state: ArtifactsPanelState;
  /** The instant the surface read at. Ages move when it re-reads and never on a timer. */
  readonly nowMilliseconds: number;
  /** The refusal the last act on a row produced, keyed by artifact id. */
  readonly rowRefusals?: ReadonlyMap<string, ConsoleRefusal> | undefined;
  /** What the most recent delete reported. The result half of the consequence. */
  readonly lastDeleteReceipt?: ArtifactDeleteReceipt | undefined;
  /**
   * Re-read one row's manifest.
   *
   * NAMED FOR WHAT THIS PANEL ASKS FOR. The port's `artifactRead` does carry a
   * payload — `includePayload` on the request, `payload` / `payloadHandle` on the
   * reply — and the artifact pane asks for one. This panel does not: it sends the
   * manifest-only shape, so a control called "fetch payload" here would be a promise
   * the participant only finds out about by pressing it.
   */
  readonly onReadManifest?: ((row: ArtifactManifestRow) => void) | undefined;
  /**
   * The rows whose manifest re-read is on the wire, so each one's control holds.
   *
   * The mounting surface's register and never a second copy: the acts single-flight the
   * re-read per row, and a control offered while that row's call is outstanding is a
   * press whose only possible answer is the refusal that says one is already in flight.
   * Absent means the surface performs no re-read at all, which is the panel's own
   * read-only mount.
   */
  readonly manifestReadInFlightArtifactIds?: ReadonlySet<string> | undefined;
  readonly onChangeVisibility?: ((row: ArtifactManifestRow) => void) | undefined;
  readonly onDelete?: ((row: ArtifactManifestRow) => void) | undefined;
}

/** One shared empty list, so the memos below see a stable reference on the row-less arms. */
const NO_ROWS: readonly ArtifactManifestRow[] = [];

/**
 * Which listing this panel is currently showing, as one comparable value.
 *
 * THE ARM IS PART OF IT, AND THAT IS THE WHOLE POINT. A list that went away and came
 * back is a different showing even when it comes back holding the same rows, because
 * the surface above re-pointed at another subject in between and the reader it minted
 * published its unread absence on the way. The row ids alone cannot tell that visit
 * from a refresh — a refresh of one session lists the same artifacts — so the arm is
 * carried beside them and the `not-checked` frame between the two is what moves this
 * value. A refresh that lists the same rows composes the same scope and holds whatever
 * a participant had open.
 */
function listingScopeOf(state: ArtifactsPanelState): string {
  return state.kind === "listed"
    ? `listed ${state.rows.map((row) => row.id).join(" ")}`
    : state.kind;
}

/**
 * The one delete confirmation this panel holds, and the listing it belongs to.
 *
 * A CONFIRMATION IS AN APPROVAL OF ONE PARTICULAR THING, so it does not outlive it —
 * `repos/proposals/proposal-gate-acts/ProposalActionGroup.tsx` states the rule at length
 * in the proposals sub-module, and this register was the copy that had not taken it. A
 * participant armed the confirm on one artifact, the deck re-pointed the pane at
 * another, and this component stayed mounted at the same tree position while its rows
 * unmounted and came back — so the row rendered again with a destructive act armed and
 * one click from firing, its consequence text having been off screen in between.
 *
 * SEEDED DURING THE RENDER THAT RE-ADDRESSES, which is what `useSubjectScopedState`
 * buys over an effect: no committed frame carries the previous listing's confirmation,
 * where an effect would clear it one commit later — and that commit is a frame in which
 * the confirm control is on screen and pressable.
 *
 * THE MOUNT IS THE SUBJECT AND THE LISTING IS THE KEY WITHIN IT. There is no live
 * object here whose replacement retires the confirmation; the thing it belongs to is a
 * value, which is exactly what a key is.
 */
function usePendingDeleteConfirmation(state: ArtifactsPanelState): DeleteConfirmState {
  const [confirmationSubject] = useState<object>(() => ({}));
  const { value, publish } = useSubjectScopedState<string | undefined>(
    confirmationSubject,
    listingScopeOf(state),
    () => undefined,
  );
  return {
    artifactIdAwaitingDeleteConfirm: value,
    setArtifactIdAwaitingDeleteConfirm: (artifactId: string | undefined) => {
      publish(artifactId);
    },
  };
}

export function ArtifactsPanel(props: ArtifactsPanelProps): React.JSX.Element {
  const [typeFilter, setTypeFilter] = useState<ArtifactTypeFilter>(ARTIFACT_TYPE_FILTER_ALL);
  const { artifactIdAwaitingDeleteConfirm, setArtifactIdAwaitingDeleteConfirm } =
    usePendingDeleteConfirmation(props.state);

  // ABSENT on every arm but `listed`, and that absence is what the head and the filter
  // group are gated on. `NO_ROWS` still backs the two memos so their inputs keep a
  // stable identity across a re-render that changed nothing — it feeds no figure.
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
        Every type is offered, including the ones at zero. Six types are ONE filter
        over ONE list — the diff pane is a view onto this list rather than a second
        store — so hiding an empty option would hide the vocabulary exactly when
        somebody is looking for something that is not in it.

        The whole group is absent until a list has answered, though: an offered filter
        is a promise that pressing it narrows something, and seven buttons all reading
        zero over a body that says the read was refused is that promise made against a
        list nobody has. Every option comes back, with its true count, the moment one
        does.
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

      {props.lastDeleteReceipt === undefined ? null : (
        <p className="meridian-artifacts__receipt" role="status">
          <Glyph name="check" size={GLYPH_SIZE_CHROME} />
          {artifactDeleteReceiptSentence(props.lastDeleteReceipt)}
        </p>
      )}

      <div className="meridian-artifacts__body">
        {renderPanelBody(props, visibleRows, typeFilter, {
          artifactIdAwaitingDeleteConfirm,
          setArtifactIdAwaitingDeleteConfirm,
        })}
      </div>
    </section>
  );
}

/**
 * The panel's arms. Each absence is its own kind; none stands in for another.
 *
 * THE TWO EMPTIES ARE TWO DIFFERENT CLAIMS, AND THE READ DECIDES WHICH. Branching
 * on the rows the FILTER kept made a session holding six artifacts state, in the
 * console's own voice, that it has none the moment somebody selected a type with no
 * matches — misreporting a successful non-empty list and hiding that the filter is
 * what is empty. So the session-empty copy is gated on what the read RETURNED, and
 * the filter's own empty is its own arm, naming the type it is set to and the count
 * it is hiding. The filter buttons stay exactly as they were: every type is offered
 * including the ones at zero, and `countsByType` already tells a reader which.
 */
function renderPanelBody(
  props: ArtifactsPanelProps,
  visibleRows: readonly ArtifactManifestRow[],
  typeFilter: ArtifactTypeFilter,
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
  if (props.state.rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No artifacts."
        detail="V1 artifacts are produced by runs and by ingest. There is no renderer control that publishes one."
      />
    );
  }
  if (visibleRows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No artifacts of the type this filter is set to."
        detail={`This session holds ${formatCount(props.state.rows.length)} of other types. Every type is on the filter above with its own count.`}
        // The type is a wire word, so it renders through the figure chokepoint rather
        // than as prose interpolated into the copy above — and it is the setting the
        // reader has to change, which is what this slot is for.
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
            refusal={props.rowRefusals?.get(row.id)}
            isManifestReadInFlight={props.manifestReadInFlightArtifactIds?.has(row.id) ?? false}
            onReadManifest={props.onReadManifest}
            onChangeVisibility={props.onChangeVisibility}
            onDelete={props.onDelete}
            confirmState={confirmState}
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
      {GROWTH_ARTIFACT_TYPES.map((artifactType) => (
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
