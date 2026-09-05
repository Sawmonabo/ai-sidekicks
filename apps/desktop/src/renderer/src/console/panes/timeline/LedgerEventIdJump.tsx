// The one jump the find field can offer, and what it says when it cannot.
//
// Its own module for the one-component rule. The find matcher searches a row's
// summary and its type and deliberately not its id, so typing an id read "No matches"
// over a row sitting on screen. This is the design's jump-by-id, reached through the
// field somebody already has open rather than through a second entry surface — and,
// being a question about ONE row rather than a count, it can say which of the four
// narrowings is hiding it.

import { Nothing } from "../../primitives/index.js";
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
