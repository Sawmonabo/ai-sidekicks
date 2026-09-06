// The run list: every run this context holds, attention first.
//
// The list renders `RunListProjection`'s rows and derives nothing of its own. That
// split is the point — the park discriminator, the band order, and the frozen-pin
// inequality are one computation with two readers (this body and its own header),
// and computing them here would be the second implementation.
//
// WHAT THIS FILE OWNS AND WHAT `RunListItem.tsx` DOES. This is the absence, the
// header's counts, and the order the rows come out in; a ROW is its own module beside
// this one, on the package's one-component-per-`.tsx` rule. The two were one file
// until the rule was given an instrument, and the row was the component a reader
// looking for it could only find by opening the list.
//
// WHERE THE ROWS COME FROM, AND WHAT STILL HAS NO WIRE. `packages/contracts` registers
// no `workflow.*` method and no `workflow.*` event type — true when this was written
// and true now — but the enumeration is no longer unreachable: it rides the growth
// port's `workflowRunList` on the `workflow-run-enumeration` slate row, which
// `runs/run-directory.ts` puts and the workflows scenario answers. That row exists
// BECAUSE the thirteen-operation workflow registry carries no run enumeration at all —
// `runStart`, `runRead`, `runCancel`, and `runResume` each address one run by an id
// the caller must already hold — so the slate names a wire the corpus still owes
// rather than a method it already has.
//
// Either way the projection reaches this component from its caller, and a caller with
// no answer renders the surface's `not-checked` absence rather than an empty list,
// because "nobody asked" and "there are none" are different facts.

import { DerivedFigure, Nothing, formatCount } from "../../primitives/index.js";
import { RunListItem } from "./RunListItem.js";
import type { OpenRun, RunListProjection } from "./run-list-projection.js";

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
