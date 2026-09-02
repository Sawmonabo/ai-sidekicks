// The run list: every run this context holds, attention first.
//
// The list renders `RunListProjection`'s rows and derives nothing of its own. That
// split is the point — the park discriminator, the band order, and the frozen-pin
// inequality are one computation with two readers (this body and its own header),
// and computing them here would be the second implementation.
//
// WHAT A ROW SHOWS, and why it stops there. The definition's name, the run's status,
// the run id, when it started, whichever parks are live, and whether the run's pin
// has fallen behind its definition. Everything else about a run — phase sections,
// retries, pool waits, outputs — is the run pane's subject and Plan-017's body; a
// list that grew them would be a second run view competing with the one that owns
// the question.
//
// ABSENT, NOT DISABLED. A row carries an open control only when the caller supplies
// the action. A list rendered without one is a list of facts, not a wall of dead
// buttons — and it is the honest shape while the deck cannot yet address a run.
//
// NO WIRE FEEDS THIS YET. `packages/contracts` registers no `workflow.*` method and
// no `workflow.*` event type, and the thirteen-operation workflow registry has no
// run enumeration at all — `runStart`, `runRead`, `runCancel`, and `runResume`
// address one run by an id the caller must already hold. So the snapshots reach this
// component from its caller, and a caller with no answer renders the surface's
// `not-checked` absence rather than an empty list, because "nobody asked" and "there
// are none" are different facts.

import { memo } from "react";

import {
  Chip,
  DerivedFigure,
  Nothing,
  WireFigure,
  formatClockTime,
  formatCount,
} from "../primitives/index.js";
import { ParkBadge } from "./ParkBadge.js";
import type {
  RunListProjection,
  WorkflowRunListRow,
  WorkflowRunState,
} from "./run-list-projection.js";

/** What a row's open control does, when a caller supplies one. */
type OpenRun = (row: WorkflowRunListRow) => void;

/** How the sentence a run carries about its own ending reads on a row. */
interface RunReasonReading {
  /**
   * `failure` is the one reading that spends the red text; everything else is prose.
   *
   * Named rather than expressed as a class name so this table says what it decides —
   * the class follows from the tone, and a table of class names would be a table of
   * spellings.
   */
  readonly tone: "failure" | "neutral";
  /**
   * What the reason is called, where the treatment alone does not say it.
   *
   * `undefined` on the failure arm, which is the one arm whose treatment IS the name:
   * red prose under a failed run reads as the failure it is, and a label above it
   * would be the surface saying twice what it has already said once.
   */
  readonly label: string | undefined;
}

/**
 * How a run's reason reads, per status.
 *
 * `failureReason` is ONE wire member carrying two different facts — it is preserved
 * on any bound breach and it also carries the reason a cancel supplied — so the run's
 * own status is the only thing that says which of them arrived. Rendered
 * unconditionally in the failure treatment, an operator's "the incident was resolved
 * out of band" was presented as a breach, which is the opposite of what happened.
 *
 * TOTAL over the status set rather than a switch with a default, and that totality is
 * the point: a default arm is how a seventh status inherits a colour nobody chose for
 * it, and a default of `failure` would inherit the wrong one. Placed here, a seventh
 * status is a compile error at this table until somebody says what its reason is
 * called.
 */
const RUN_REASON_READINGS = {
  // The four statuses no V1 producer sends a reason with. They take the neutral arm
  // anyway rather than being left out: a reason arriving on one of them is a fact
  // this list shows, and showing it in red would be inventing an outcome for it.
  pending: { tone: "neutral", label: "Reason" },
  running: { tone: "neutral", label: "Reason" },
  suspended: { tone: "neutral", label: "Reason" },
  completed: { tone: "neutral", label: "Reason" },
  failed: { tone: "failure", label: undefined },
  cancelled: { tone: "neutral", label: "Cancellation reason" },
} as const satisfies Readonly<Record<WorkflowRunState, RunReasonReading>>;

/**
 * The sentence a run carries about its ending, read as what its status makes it.
 *
 * The daemon's text verbatim in both arms — only the treatment and the name in front
 * of it change, because paraphrasing the engine is what the refusal grammar exists to
 * prevent.
 */
function renderRunReason(state: WorkflowRunState, reason: string): React.JSX.Element {
  const reading = RUN_REASON_READINGS[state];
  return reading.tone === "failure" ? (
    <p className="meridian-run-row__failure">{reason}</p>
  ) : (
    <p className="meridian-run-row__reason">
      <span className="meridian-run-row__reason-label">{reading.label}</span> {reason}
    </p>
  );
}

interface RunListItemProps {
  readonly row: WorkflowRunListRow;
  /** Required-and-nullable rather than optional: every construction site sets it. */
  readonly onOpenRun: OpenRun | undefined;
}

/**
 * One run's row.
 *
 * Memoized because a run list re-renders whenever any run in it moves, and a park
 * badge that re-rendered on every neighbour's transition would be paying for
 * everyone else's changes. The projection hands out frozen row values, so the
 * default shallow comparison is exactly the right one: a row object is replaced when
 * and only when something in that run changed.
 */
const RunListItem = memo(function RunListItem(props: RunListItemProps): React.JSX.Element {
  const { row, onOpenRun } = props;
  const { run } = row;
  // The definition's name where the caller holds one, and the run's own identity
  // where it does not. No registered read joins a run to the name of the definition
  // it was started from, so the fallback is the opaque id the wire DID send, worn as
  // a wire value in mono — which reads as an identifier rather than as a title, and
  // is the one thing on this row a person can paste into a search.
  const runLabel =
    run.definitionName === undefined ? (
      <WireFigure value={run.workflowRunId} />
    ) : (
      run.definitionName
    );
  return (
    <li className="meridian-run-row">
      <div className="meridian-run-row__head">
        {onOpenRun === undefined ? (
          <span className="meridian-run-row__name">{runLabel}</span>
        ) : (
          <button
            type="button"
            className="meridian-run-row__name meridian-run-row__open"
            onClick={() => {
              onOpenRun(row);
            }}
          >
            {runLabel}
          </button>
        )}
        {/*
          The status is the daemon's own word for this run, so it wears the mono
          provenance signature rather than being title-cased into prose. Its tone is
          the status itself and not a reading of the parks: a run whose phases are
          parked shows that on its park badges, and colouring the status chip for it
          too would spend amber twice on one fact.
        */}
        <Chip tone={run.state === "failed" ? "failure" : "neutral"} mono label={run.state} />
        {/*
          The frozen pin states a condition and offers nothing. Whether it may be
          repaired is the daemon's adjudication on a resume, and an operator who asks
          meets `workflow.repair_not_parked`, `workflow.repair_attempt_in_flight`, or
          `workflow.repair_version_unaccountable` — rendered as the refusal it is,
          never predicted here.
        */}
        {row.isPinnedBehindLatestVersion ? (
          <Chip tone="neutral" glyph="workflow" label="Frozen on an older version" />
        ) : null}
      </div>
      <div className="meridian-run-row__meta">
        <WireFigure value={run.workflowRunId} />
        <WireFigure value={formatClockTime(run.startedAt)} title={run.startedAt} />
        {row.isPinnedBehindLatestVersion ? (
          <span className="meridian-run-row__pin">
            pinned <WireFigure value={run.workflowVersionId} />
          </span>
        ) : null}
      </div>
      {row.parkedPhases.length === 0 ? null : (
        <ul className="meridian-run-row__parks">
          {row.parkedPhases.map((parked) => (
            <li key={parked.phaseId}>
              <ParkBadge parked={parked} />
            </li>
          ))}
        </ul>
      )}
      {run.failureReason === undefined ? null : renderRunReason(run.state, run.failureReason)}
    </li>
  );
});

export interface RunListProps {
  readonly projection: RunListProjection;
  /** Opens one run. Absent while nothing can address one. */
  readonly onOpenRun?: OpenRun | undefined;
}

/** Every run, attention first, with each live park said in place. */
export function RunList(props: RunListProps): React.JSX.Element {
  const { rows, parkedRunCount, frozenPinCount } = props.projection;
  if (rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="surface"
        title="No runs here."
        detail="A run started from a definition appears here, with whatever it is waiting on said in place."
      />
    );
  }
  return (
    <div className="meridian-run-list">
      {/*
        The counts are the console's own readings of the list it is showing, so they
        wear the derived signature rather than the wire's. The noun sits beside the
        figure rather than inside it: a count folded into a sentence would have to
        pluralize, and a hand-pluralized string is a formatter this console has
        exactly one home for and no reason to grow a second of.
      */}
      <div className="meridian-run-list__summary">
        <span className="meridian-run-list__summary-item">
          Runs <DerivedFigure text={formatCount(rows.length)} />
        </span>
        {parkedRunCount === 0 ? null : (
          <span className="meridian-run-list__summary-item">
            Parked <DerivedFigure text={formatCount(parkedRunCount)} />
          </span>
        )}
        {frozenPinCount === 0 ? null : (
          <span className="meridian-run-list__summary-item">
            Frozen pins <DerivedFigure text={formatCount(frozenPinCount)} />
          </span>
        )}
      </div>
      {/*
        Ordered, because the order is the content: parked runs first, then active,
        then settled, newest first inside each. A reader who cannot see that sequence
        cannot tell a list sorted by attention from one sorted by chance.
      */}
      <ol className="meridian-run-list__rows">
        {rows.map((row) => (
          <RunListItem key={row.run.workflowRunId} row={row} onOpenRun={props.onOpenRun} />
        ))}
      </ol>
    </div>
  );
}
