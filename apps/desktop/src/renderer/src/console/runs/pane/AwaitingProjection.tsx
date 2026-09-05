// The runs the pane knows the ids of and has no projected row for yet.
//
// Split from `RunsPane.tsx`. This is deliberately NOT an empty state: the ids came
// off a read, so the runs exist; what has not arrived is the projection that would
// describe them. Naming them is the honest report, and dropping them would make a
// run the daemon told us about disappear from a pane that had been told.

import { DerivedFigure, formatCount, WireFigure } from "../../primitives/index.js";

/**
 * The runs the session knows and the live tail has not described.
 *
 * Beside the rows and never in place of them: each of these runs already HAS a row,
 * seated from the session's own record, so this sentence qualifies the list rather
 * than standing in for it. It names the ids as well as the count because the count
 * alone leaves a person unable to tell which of the rows in front of them is the
 * one that is not live.
 */
export function AwaitingProjection(props: {
  readonly runIds: readonly string[];
}): React.JSX.Element {
  return (
    <p className="meridian-runs__awaiting-projection">
      The live run-state stream has not described{" "}
      <DerivedFigure text={formatCount(props.runIds.length)} />{" "}
      {props.runIds.length === 1 ? "run" : "runs"} this session knows, so{" "}
      {props.runIds.length === 1 ? "its row reads" : "their rows read"} from the session&apos;s own
      record rather than from a live reading:{" "}
      {props.runIds.map((runId, position) => (
        <span key={runId}>
          {position === 0 ? null : ", "}
          <WireFigure value={runId} />
        </span>
      ))}
      .
    </p>
  );
}
