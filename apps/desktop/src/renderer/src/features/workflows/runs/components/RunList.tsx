// The run list: every run this context holds, newest first.
//
// The list renders `RunListProjection`'s rows and derives nothing of its own. That
// split is the point — the park discriminator, the parked flag, and the frozen-pin
// inequality are one computation with two readers (this body and its own header),
// and computing them here would be the second implementation.
//
// WHAT THIS FILE OWNS AND WHAT `RunListItem.tsx` DOES. This is the absence, the
// header's counts, and the order the rows come out in; a ROW is its own module beside
// this one, on the package's one-component-per-`.tsx` rule. The two were one file
// until the rule was given an instrument, and the row was the component a reader
// looking for it could only find by opening the list.
//
// The projection reaches this component from its caller. A served answer of no runs is
// a real answer and draws the `empty` absence; a caller with no answer does not mount
// this list, because "nobody asked" and "there are none" are different facts.

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
        {/*
          THE BADGE COUNTS ENTRIES AND NOT RUNS, which is the fold's whole point:
          six runs parked on one spent provider account are one thing to look at,
          and a figure reading `6` here beside one line under it would undo the fold
          on the figure most likely to be glanced at rather than read. It is
          deliberately a different number from `Parked` above, which counts runs —
          the two answer different questions and agreeing by construction would mean
          one of them was not being asked.

          And never a zero: nothing waiting is the ordinary state of a healthy
          session, on the same rule the two counts beside it already obey.
        */}
        {parkAttentionCount === 0 ? null : (
          <span className="meridian-run-list__summary-item">
            Waiting on <DerivedFigure text={formatCount(parkAttentionCount)} />
          </span>
        )}
      </div>
      {/*
        The fold stands above the rows because it is the question a person opening
        this list is asking — what is holding things up — and the rows are the answer
        to a different one. It renders nothing at all when nothing is parked.
      */}
      <RunParkAttention entries={parkAttention} />
      {/*
        Ordered, because the order is the content: newest first, so the run a person
        just started is the top row. A reader who cannot see that sequence cannot tell
        a list sorted by start from one sorted by chance.
      */}
      <ol className="meridian-run-list__rows">
        {rows.map((row) => (
          <RunListItem key={row.run.workflowRunId} row={row} onOpenRun={props.onOpenRun} />
        ))}
      </ol>
    </div>
  );
}
