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
//
// AND THE TWO NUMBERS ANSWER IN TWO SENTENCES, BECAUSE ONE SENTENCE MADE A CLAIM
// ABOUT RUNS THAT HAVE NO ROW. The opening figure counts every undescribed run —
// seated and withheld together — and the clause after it used to say their rows read
// from the session's own record, which is false for every withheld one, whose whole
// point is that the seating cap drew no row for it. The withheld count was then
// reported a SECOND time, in the trailing sentence, as having no row: the same runs
// described both ways in one paragraph. So the count sentence stands alone, and what
// follows it is scoped to the rows this pane actually drew.

import { DerivedFigure, formatCount, WireFigure } from "../../primitives/index.js";
import { AWAITING_RUN_IDS_NAMED_CAP } from "../../core/index.js";

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
 *
 * THE ROW SENTENCE CARRIES NO COUNT OF ITS OWN. What has a row is exactly what the
 * enumeration names plus the "more" figure after it, so a third number stating the
 * same total would be a second place to get it right — and the one number a reader
 * needs that neither of those gives is the withheld one, which has its own sentence.
 */
export function AwaitingProjection(props: {
  readonly runIds: readonly string[];
  readonly withheldCount: number;
}): React.JSX.Element {
  const seatedCount = props.runIds.length;
  const undescribedCount = seatedCount + props.withheldCount;
  const namedRunIds = props.runIds.slice(0, AWAITING_RUN_IDS_NAMED_CAP);
  // The seated runs past the naming cap, and deliberately NOT every undescribed run
  // past it: a withheld run is not a row this paragraph declined to name, it is a row
  // the pane never drew, and folding the two together is what let the trailing
  // sentence contradict this one.
  const unnamedSeatedCount = seatedCount - namedRunIds.length;
  return (
    <p className="meridian-runs__awaiting-projection">
      The live run-state stream has not described{" "}
      <DerivedFigure text={formatCount(undescribedCount)} />{" "}
      {undescribedCount === 1 ? "run" : "runs"} this session knows.{" "}
      {seatedCount === 1 ? "The row on this pane reads" : "The rows on this pane read"} from the
      session&apos;s own record rather than from a live reading:{" "}
      {namedRunIds.map((runId, position) => (
        <span key={runId}>
          {position === 0 ? null : ", "}
          <WireFigure value={runId} />
        </span>
      ))}
      {unnamedSeatedCount > 0 ? (
        <>
          , and <DerivedFigure text={formatCount(unnamedSeatedCount)} /> more
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
