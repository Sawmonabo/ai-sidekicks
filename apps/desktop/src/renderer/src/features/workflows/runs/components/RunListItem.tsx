// One run's row: the definition it came from, its state, when it started, its parked phases, and
// the sentence it carries about its own ending. Everything else about a run belongs to the run
// pane. The open control is absent, not disabled, when the caller supplies none. The row derives
// nothing; every reading arrives on the row value from `run-list-projection.ts`.

import { memo } from "react";

import type { InstantReading } from "@renderer/lib/instant.js";
import { Chip } from "@renderer/components/Chip/Chip.js";
import { WireFigure } from "@renderer/components/WireFigure/WireFigure.js";
import { UNREADABLE_FIGURE, formatDateTime } from "@renderer/lib/wire-figures.js";
import { ParkBadge } from "../../components/ParkBadge.js";
import type { OpenRun, WorkflowRunListRow } from "../run-list-projection.js";
import type { WorkflowRunState } from "../run-list-rows.js";

/**
 * The start a row prints, taken from the reading the projection already made. `formatDateTime`
 * accepts any offset while `workflowInstant` and the sort accept UTC only, so formatting
 * `run.startedAt` directly would print a legible time for a start the sort placed last as
 * unreadable.
 */
function startFigureFor(startedAt: InstantReading): string {
  return startedAt.kind === "malformed" ? UNREADABLE_FIGURE : formatDateTime(startedAt.text);
}

/** How the sentence a run carries about its own ending reads on a row. */
interface RunReasonReading {
  /** `failure` is the one reading that spends the red text; the class follows from the tone. */
  readonly tone: "failure" | "neutral";
  /** What the reason is called; `undefined` on the failure arm, whose red treatment is the name. */
  readonly label: string | undefined;
}

/**
 * How a run's reason reads, per status.
 *
 * `failureReason` is one wire member carrying two facts, a bound breach's reason and a cancel's,
 * so the status alone says which arrived. Total over the status set, not a switch with a
 * default: a new status is a compile error here until someone says what its reason is called.
 */
const RUN_REASON_READINGS = {
  // No producer sends a reason with these four; a reason that arrives is shown neutral, not red.
  pending: { tone: "neutral", label: "Reason" },
  running: { tone: "neutral", label: "Reason" },
  suspended: { tone: "neutral", label: "Reason" },
  completed: { tone: "neutral", label: "Reason" },
  failed: { tone: "failure", label: undefined },
  canceled: { tone: "neutral", label: "Cancellation reason" },
} as const satisfies Readonly<Record<WorkflowRunState, RunReasonReading>>;

/** The sentence a run carries about its ending, the daemon's text verbatim in both arms. */
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
 * One run's row. Memoized because the list re-renders whenever any run moves; the projection
 * hands out frozen rows, so shallow comparison replaces a row exactly when its run changed.
 */
export const RunListItem: React.MemoExoticComponent<
  (props: RunListItemProps) => React.JSX.Element
> = memo(function RunListItem(props: RunListItemProps): React.JSX.Element {
  const { row, onOpenRun } = props;
  const { run } = row;
  // No read joins a run to its definition's name, so the fallback is the wire id, in mono.
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
          The status is the daemon's word, in the mono signature. Its tone is the status, not the
          parks: the park badges already say that, and amber would be spent twice.
        */}
        <Chip tone={run.state === "failed" ? "failure" : "neutral"} mono label={run.state} />
        {/*
          States a condition and offers nothing: whether the pin may be repaired is the daemon's
          answer on a resume, rendered as the refusal it is (`workflow.repair_not_parked` and
          the like), never predicted here.
        */}
        {row.isPinnedBehindLatestVersion ? (
          <Chip tone="neutral" glyph="workflow" label="Frozen on an older version" />
        ) : null}
      </div>
      <div className="meridian-run-row__meta">
        <WireFigure value={run.workflowRunId} />
        {/*
          The start carries its date: unlike a transcript nothing here divides rows by day. The
          title is the wire's own spelling, so a malformed start is not reported as absent.
        */}
        <WireFigure value={startFigureFor(row.startedAt)} title={run.startedAt} />
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
