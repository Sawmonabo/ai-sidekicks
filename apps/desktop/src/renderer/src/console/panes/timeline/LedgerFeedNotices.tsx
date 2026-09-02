// What this window is not, said out loud — and the one jump the field can offer.
//
// Split from `LedgerFeed.tsx` for the reason that file splits from the pane: these
// are pure renderings of counts and outcomes the feed already derived, with no
// store, no seat and no scroll writer between them and their props. Keeping them
// beside the arrangement made one module hold both the composition and every
// sentence it can say.
//
// FOUR ABSENCES AND ONE OFFER. The absences are the ways this window is less than
// the session; the offer is the design's jump-by-id, which is the one case where a
// missing row has something a person can press.

import { Nothing } from "../../primitives/index.js";
import { type LedgerJumpOutcome } from "../../ledger/structure/index.js";

/**
 * What a query that names a row id offers, and what it says when it cannot.
 *
 * The find matcher searches a row's summary and its type and deliberately not its
 * id, so typing an id read "No matches" over a row sitting on screen. This is the
 * design's jump-by-id, reached through the field somebody already has open rather
 * than through a second entry surface.
 *
 * THE HIDDEN ARM IS WHY THE OUTCOME IS A UNION. An id this window does not hold and
 * an id the filter is currently hiding call for different words — the second is
 * reachable by clearing the filter, and telling somebody to load rows they already
 * have would be the wrong sentence. That arm was unreachable until the ledger could
 * be narrowed at all.
 *
 * An ordinary text query lands in `outside-window` and renders nothing.
 */
export function LedgerEventIdJump(props: {
  readonly outcome: LedgerJumpOutcome;
  readonly onJumpToRow: (rowId: string) => void;
}): React.JSX.Element | null {
  const { outcome } = props;
  if (outcome.status === "outside-window") {
    return null;
  }
  if (outcome.status === "hidden-by-filter") {
    return (
      <Nothing
        kind="not-loaded"
        placement="inline"
        title="That entry is hidden by the filter."
        detail={`${outcome.row.summary} is in this window, but the current narrowing does not admit it. Clear the filter to reach it.`}
      />
    );
  }
  return (
    <p className="meridian-ledger__jump">
      <button
        type="button"
        className="meridian-ledger__jump-action"
        onClick={() => {
          props.onJumpToRow(outcome.row.id);
        }}
      >
        Go to that entry
      </button>
    </p>
  );
}

/** Matches the query found in rows the cap has taken out of this window. */
export function LedgerMatchesOutsideWindowNotice(props: {
  readonly count: number;
}): React.JSX.Element | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <Nothing
      kind="not-loaded"
      placement="inline"
      title="Some matches are outside this window."
      detail={`${String(props.count)} more entr${props.count === 1 ? "y" : "ies"} match, in older rows this window no longer holds. The walk steps only through rows the feed can scroll to.`}
    />
  );
}

/** Matches the query found in rows the replay position has not reached yet. */
export function LedgerMatchesNotYetReplayedNotice(props: {
  readonly count: number;
}): React.JSX.Element | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <Nothing
      kind="not-loaded"
      placement="inline"
      title="Some matches are ahead of the replay position."
      detail={`${String(props.count)} more entr${props.count === 1 ? "y" : "ies"} match, in rows this replay has not reached. Scrub the dock forward to walk them.`}
    />
  );
}

interface LedgerWindowAbsencesProps {
  /** Events the contract package registers no category for. */
  readonly unprojectableEventCount: number;
  /** Rows the log holds and this window does not, because the cap took them. */
  readonly droppedRowCount: number;
  /** Rows the log holds and this window does not, because replay has not reached them. */
  readonly withheldByReplayRowCount: number;
  /** The store recorded sequences it never received. */
  readonly hasUnreceivedEntries: boolean;
}

/**
 * The four ways this window is not the whole session, each said out loud.
 *
 * Four separate sentences because a person's next move differs for each: an
 * unrecognised type is this build's limit, a dropped row is the window's cap, a row
 * ahead of the replay position is a control they are holding, and a sequence that
 * never arrived is the stream's. Collapsing any two would tell somebody the console
 * failed where it merely stopped holding, or the reverse — and collapsing the middle
 * two told them rows they can scrub back to in a keystroke were gone for good.
 *
 * Three of them name the read that is missing rather than offering a control for
 * it, which is what replaced the "load earlier" button: this console holds one live
 * subscription and a whole-session snapshot read, and neither takes a cursor. The
 * replay one is the exception, and it is the honest one — the control that would
 * undo it is on screen.
 */
export function LedgerWindowAbsences(props: LedgerWindowAbsencesProps): React.JSX.Element | null {
  if (
    props.unprojectableEventCount === 0 &&
    props.droppedRowCount === 0 &&
    props.withheldByReplayRowCount === 0 &&
    !props.hasUnreceivedEntries
  ) {
    return null;
  }
  return (
    <>
      {props.unprojectableEventCount === 0 ? null : (
        <Nothing
          kind="not-checked"
          placement="surface"
          title="Some entries could not be placed."
          detail={`${String(props.unprojectableEventCount)} event${props.unprojectableEventCount === 1 ? "" : "s"} arrived with a type this build does not recognise, so they are not shown.`}
        />
      )}
      {props.droppedRowCount === 0 ? null : (
        <Nothing
          kind="not-loaded"
          placement="surface"
          title="Older entries are no longer in this window."
          detail={`${String(props.droppedRowCount)} entr${props.droppedRowCount === 1 ? "y" : "ies"} left the window as the session grew. This console subscribes to the log and holds no read that fetches a range of it, so there is nothing to press here.`}
        />
      )}
      {props.withheldByReplayRowCount === 0 ? null : (
        <Nothing
          kind="not-loaded"
          placement="surface"
          title="Later entries are behind the replay position."
          detail={`${String(props.withheldByReplayRowCount)} entr${props.withheldByReplayRowCount === 1 ? "y" : "ies"} in this window come after where the replay dock is parked. Scrub forward, or play on, and they come back.`}
        />
      )}
      {props.hasUnreceivedEntries ? (
        <Nothing
          kind="not-loaded"
          placement="surface"
          title="Some entries never arrived."
          detail="The session numbered entries this window did not receive. They come back only when the whole session is read again, which the store asks for on its own; no read here fetches a range."
        />
      ) : null}
    </>
  );
}
