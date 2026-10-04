// The run list: every run this context holds, newest first. It renders `RunListProjection`'s rows
// and derives nothing, so the park discriminator, parked flag and frozen-pin inequality have one
// implementation. A served answer of no runs draws the `empty` state; a caller with no answer
// does not mount this list.

import "./RunList.css";

import { DerivedFigure } from "@renderer/components/DerivedFigure/DerivedFigure.js";
import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import { formatCount } from "@renderer/lib/wire-figures.js";
import { RunListItem } from "./RunListItem.js";
import { RunParkAttention } from "./RunParkAttention.js";
import type { OpenRun, RunListProjection } from "../run-list-projection.js";

/** What the run list draws and the control that opens one of its rows. */
export interface RunListProps {
  readonly projection: RunListProjection;
  /** Opens one run. Absent while nothing can address one. */
  readonly onOpenRun?: OpenRun | undefined;
}

/** Every run, newest first, with each live park said in place. */
export function RunList(props: RunListProps): React.JSX.Element {
  const { rows, parkedRunCount, frozenPinCount, parkAttention, parkAttentionCount } =
    props.projection;
  if (rows.length === 0) {
    return (
      <Nothing
        kind="empty"
        placement="block"
        title="No runs here."
        detail={
          "A run started from a definition appears here, with whatever it " +
          "is waiting on said in place."
        }
      />
    );
  }
  return (
    <div className="meridian-run-list">
      {/*
        The counts wear the derived signature. The noun sits beside the figure so no count is
        folded into a sentence that would need pluralizing.
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
        {/*
          Counts entries, not runs: six runs parked on one spent account are one thing to look
          at, so this differs from `Parked` above on purpose. Never a zero, like the counts
          beside it.
        */}
        {parkAttentionCount === 0 ? null : (
          <span className="meridian-run-list__summary-item">
            Waiting on <DerivedFigure text={formatCount(parkAttentionCount)} />
          </span>
        )}
      </div>
      {/* The fold stands above the rows: it answers what is holding things up. */}
      <RunParkAttention entries={parkAttention} />
      {/* Ordered because the order is the content: newest first. */}
      <ol className="meridian-run-list__rows">
        {rows.map((row) => (
          <RunListItem key={row.run.workflowRunId} row={row} onOpenRun={props.onOpenRun} />
        ))}
      </ol>
    </div>
  );
}
