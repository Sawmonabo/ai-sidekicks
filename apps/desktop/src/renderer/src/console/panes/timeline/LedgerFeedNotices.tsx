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
// missing row has something a person can press — and which, being a question about
// ONE row rather than a count, can say which of the four is hiding it.

import { Nothing, WindowAbsences } from "../../primitives/index.js";
import { type LedgerScope } from "../../ledger/frame/index.js";
import { type LedgerJumpAbsence, type LedgerJumpOutcome } from "../../ledger/structure/index.js";
import { type LedgerJumpReach } from "./ledger-jump.js";

/**
 * What each absence is, in this ledger's own words.
 *
 * TOTAL OVER THE ABSENCE TUPLE, so a fifth narrowing added to the pipeline is a
 * compile error here rather than a row that silently renders the fourth one's
 * sentence. Each entry names what is true of the row and nothing about what to do
 * about it: the act is the caller's, because whether one exists depends on this
 * ledger's state and not on the absence.
 */
const JUMP_ABSENCE_WORDS = {
  "hidden-by-filter": {
    title: "That entry is hidden by the filter.",
    detail: "is in this window, but the current narrowing does not admit it.",
  },
  "folded-into-chapter": {
    // TRUE OF BOTH WAYS A CHAPTER WITHHOLDS A ROW, which is what the previous
    // wording was not: it said the run's rows were "folded away behind their
    // chapter", and this arm also fires for a chapter that is OPEN — the arm with
    // no act — where the row sits past the ceiling the chapter draws at once.
    // Naming only the fold told somebody to open a chapter that was already open.
    title: "That entry is inside a chapter that is not showing it.",
    detail:
      "belongs to a run whose chapter is folded shut, or is open and holds more entries than it draws at once.",
  },
  "withheld-by-replay": {
    title: "That entry is behind the replay position.",
    detail: "is in this window, and the replay running over it has not reached it.",
  },
  "outside-window": {
    title: "That entry is no longer in this window.",
    detail:
      "left the window as the session grew. This console subscribes to the log and holds no read that fetches a range of it, so there is nothing to press here.",
  },
} as const satisfies Readonly<Record<LedgerJumpAbsence, { title: string; detail: string }>>;

/**
 * What a query that names a row id offers, and what it says when it cannot.
 *
 * The find matcher searches a row's summary and its type and deliberately not its
 * id, so typing an id read "No matches" over a row sitting on screen. This is the
 * design's jump-by-id, reached through the field somebody already has open rather
 * than through a second entry surface.
 *
 * FIVE ANSWERS AND NOT TWO, WHICH IS WHY THE OUTCOME IS A UNION. Between the
 * loaded log and this viewport a row passes four narrowings, and until each got
 * its own arm the LAST one that had a name spoke for all of them: a row folded
 * into a chapter, a row a replay was holding back and a row the cap had taken were
 * all reported as hidden by the filter, so a ledger with no filter on it offered
 * to clear one. Now each absence says what is true and, where an act reaches the
 * row, offers that act by name.
 *
 * `undefined` is a field nobody has typed in. It renders nothing, and so does an
 * id this window does not carry — see the arm itself for why that one is silent.
 */
export function LedgerEventIdJump(props: {
  readonly outcome: LedgerJumpOutcome | undefined;
  readonly reach: LedgerJumpReach | undefined;
  readonly onJumpToRow: (rowId: string) => void;
}): React.JSX.Element | null {
  const { outcome, reach } = props;
  if (outcome === undefined) {
    return null;
  }
  if (outcome.status === "found") {
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
  if (outcome.status === "not-in-loaded-log") {
    // SILENT ON PURPOSE, and this is the one arm that is. The field is a text
    // search as well as an id entry, so every ordinary query — "run", "read_file" —
    // lands here, and a sentence about an id nothing carries would be printed over
    // every search somebody performs. The console cannot tell an id it does not
    // hold from a word, so it says nothing rather than guessing which one it was.
    return null;
  }
  const words = JUMP_ABSENCE_WORDS[outcome.status];
  return (
    <Nothing
      // `empty` and not `not-loaded`: that kind is a skeleton, so it announces its
      // title rather than setting it and drops the detail entirely — right for a
      // read in flight, wrong for a settled answer to a question somebody asked.
      kind="empty"
      placement="surface"
      title={words.title}
      detail={`${outcome.row.summary} ${words.detail}`}
      action={
        reach === undefined ? undefined : (
          <button type="button" className="meridian-ledger__jump-action" onClick={reach.perform}>
            {reach.label}
          </button>
        )
      }
    />
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

/**
 * Rows the log admitted after a walk began — an absence the walk cannot close.
 *
 * SEPARATE FROM THE WITHHELD COUNT BELOW, and the separation is the point: a row
 * ahead of the position comes back when the dock is scrubbed forward, and a row
 * admitted after the walk began was never in the walk at all, so scrubbing to the
 * very end of it reveals nothing. Reporting the two together would offer an action
 * that cannot work for half the rows it named.
 */
export function LedgerRowsAdmittedDuringReplayNotice(props: {
  readonly count: number;
  readonly onEndReplay: () => void;
}): React.JSX.Element | null {
  if (props.count === 0) {
    return null;
  }
  return (
    <Nothing
      // `empty` AND NOT `not-loaded`, which is what the sentences around it name:
      // that kind is a skeleton, so its title is announced rather than set and its
      // detail is dropped, which is right for a read in flight and wrong for a
      // settled fact nothing will replace. This walk succeeded and holds none of
      // these rows, and the next move is a control — which is the slot `empty`
      // carries and the reason the button is passed rather than drawn beside it.
      kind="empty"
      placement="surface"
      title="The session moved on while this replay was running."
      detail={`${String(props.count)} entr${props.count === 1 ? "y" : "ies"} arrived after this replay started. A replay walks the rows it began with, so scrubbing forward does not reach them.`}
      action={
        <button type="button" className="meridian-ledger__jump-action" onClick={props.onEndReplay}>
          Leave the replay and catch up
        </button>
      }
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

/**
 * What the window holds, named so the sentence says WHOSE absence it is.
 *
 * The unrecognised count is measured before a channel scope can apply, and an event
 * this build cannot place carries no channel it could be counted under — so a channel
 * pane says it is the session's fact rather than implying its own. It is a subject
 * noun and not a second set of sentences: `primitives/window-absence.ts` writes the
 * words, and this decides only which things they are about.
 */
const SESSION_WIDE_SUBJECT: Readonly<Record<LedgerScope, string>> = {
  session: "entries",
  channel: "of the session's entries",
};

interface LedgerWindowAbsencesProps {
  /** Events the contract package registers no category for. */
  readonly unprojectableEventCount: number;
  /** Rows the log holds and this window does not, because the cap took them. */
  readonly droppedRowCount: number;
  /** Rows the log holds and this window does not, because replay has not reached them. */
  readonly withheldByReplayRowCount: number;
  /** The store recorded sequences it never received. */
  readonly hasUnreceivedEntries: boolean;
  /** What this ledger is a log of — whose absence the first one is. */
  readonly scope: LedgerScope;
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
 * THE SENTENCES ARE THE CONSOLE'S NOW, NOT THIS LEDGER'S. Six families each wrote
 * their own wording for this case and they disagreed; `primitives/window-absence.ts`
 * says it once and this hands it the readings it derived. One behaviour change comes
 * with that, on purpose: the never-received arm used to render as `not-loaded`, whose
 * skeleton branch drops `title` and `detail`, so its sentence reached nobody. The
 * shared module renders it as the settled absence it is, so it is shown.
 *
 * TWO GROUPS AND NOT ONE, because the two session-wide absences and the two window
 * absences are about different things and the subject noun is how the shared
 * sentences say which. The unrecognised count takes the scoped noun; the rest take
 * the plain one. The never-received arm is in the second group even though its fact
 * is the session's as well — the shared sentence for it puts the subject inside its
 * detail line too, where "of the session's entries" does not parse — so a channel
 * pane no longer qualifies that one. That is the honest limit of the shared shape,
 * and it is worth less than a seventh copy of all four sentences.
 */
export function LedgerWindowAbsences(props: LedgerWindowAbsencesProps): React.JSX.Element | null {
  return (
    <>
      <WindowAbsences
        absences={[{ kind: "unprojectable", count: props.unprojectableEventCount }]}
        subject={SESSION_WIDE_SUBJECT[props.scope]}
      />
      <WindowAbsences
        // The order is the pipeline's: what the cap took, what the replay is
        // holding, and what never arrived. Counted absences at zero are dropped by
        // the model, so nothing is guarded here.
        absences={[
          { kind: "dropped", count: props.droppedRowCount },
          { kind: "withheld-by-replay", count: props.withheldByReplayRowCount },
          ...(props.hasUnreceivedEntries ? ([{ kind: "never-received" }] as const) : []),
        ]}
        subject="entries"
      />
    </>
  );
}
