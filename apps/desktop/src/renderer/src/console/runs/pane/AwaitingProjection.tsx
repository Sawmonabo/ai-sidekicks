// The runs the pane knows the ids of and has no projected row for yet.
//
// Split from `RunsPane.tsx`. This is deliberately NOT an empty state: the ids came
// off a read, so the runs exist; what has not arrived is the projection that would
// describe them. Naming them is the honest report, and dropping them would make a
// run the daemon told us about disappear from a pane that had been told.
//
// THE ENUMERATION IS BOUNDED AND THE COUNT IS NOT. This paragraph used to map every
// id into its own figure, inline, with no ceiling — a session's un-projected runs
// are as many as the session is old, so a long-lived one rendered a paragraph of
// hex. The ids are a LOOKUP ("which of these rows is not live"), and past a handful
// a lookup stops working; the count is the reading, and it names every run whether a
// row was drawn for it or not.

import { DerivedFigure, formatCount, WireFigure } from "../../primitives/index.js";
import { AWAITING_RUN_IDS_NAMED_CAP } from "./runs-bounds.js";

/**
 * The runs the session knows and the live tail has not described.
 *
 * Beside the rows and never in place of them: the seated ones already HAVE a row,
 * read from the session's own record, so this sentence qualifies the list rather
 * than standing in for it.
 *
 * TWO NUMBERS, BECAUSE THEY ANSWER TWO QUESTIONS. `runIds` are the runs a row was
 * seated for; `withheldCount` is how many further such runs the seating cap kept
 * off the pane entirely. Their sum is what the session knows and the stream has not
 * described, which is the figure the first sentence reports — a person reading a
 * count that silently meant "as many as we happened to draw" would take a bounded
 * pane for a complete one.
 */
export function AwaitingProjection(props: {
  readonly runIds: readonly string[];
  readonly withheldCount: number;
}): React.JSX.Element {
  const undescribedCount = props.runIds.length + props.withheldCount;
  const namedRunIds = props.runIds.slice(0, AWAITING_RUN_IDS_NAMED_CAP);
  const unnamedCount = undescribedCount - namedRunIds.length;
  return (
    <p className="meridian-runs__awaiting-projection">
      The live run-state stream has not described{" "}
      <DerivedFigure text={formatCount(undescribedCount)} />{" "}
      {undescribedCount === 1 ? "run" : "runs"} this session knows, so{" "}
      {undescribedCount === 1 ? "its row reads" : "their rows read"} from the session&apos;s own
      record rather than from a live reading:{" "}
      {namedRunIds.map((runId, position) => (
        <span key={runId}>
          {position === 0 ? null : ", "}
          <WireFigure value={runId} />
        </span>
      ))}
      {unnamedCount > 0 ? (
        <>
          , and <DerivedFigure text={formatCount(unnamedCount)} /> more
        </>
      ) : null}
      .
      {props.withheldCount > 0 ? (
        <>
          {" "}
          <DerivedFigure text={formatCount(props.withheldCount)} />{" "}
          {props.withheldCount === 1 ? "has no row on this pane" : "have no row on this pane"}: it
          seats the newest of them and counts the rest.
        </>
      ) : null}
    </p>
  );
}
