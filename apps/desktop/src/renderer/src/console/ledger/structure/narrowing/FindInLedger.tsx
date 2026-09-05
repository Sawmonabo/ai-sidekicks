// The find field, and the boundary it states.
//
// `find-model.ts` owns the rule this field renders: find runs over the loaded rows with
// a match count and next and previous, and states its boundary in the field.
//
// THE BOUNDARY IS RENDERED, NOT REMEMBERED. `LEDGER_FIND_SCOPE_NOTE` is one string
// in `find-model.ts` and this is its only renderer, so the field cannot ship
// without the sentence and the sentence cannot drift from what the matcher
// actually did. The "load earlier" affordance appears when there are earlier rows
// AND a caller can actually fetch them — offering it over a complete window, or
// over a reader that has no way to page, would promise something the press could
// not deliver. Absent rather than disabled, which is this console's rule for a
// control whose act nobody can perform.
//
// TWO BOUNDARIES, NOT ONE. `LEDGER_FIND_SCOPE_NOTE` bounds what was SEARCHED; the
// cap sentence beside it bounds what can be STEPPED THROUGH, and appears only when
// the query found more matches than the walk holds. Collapsing them would leave the
// second boundary unstated, which is exactly what let the counter advertise a total
// containing matches no press could reach.
//
// COUNTS ARE THE CONSOLE'S OWN READING, not wire figures: "3 of 17" is derived by
// this console from rows it holds, so it renders proportionally through
// `DerivedFigure` rather than in the mono the daemon's own figures wear (rule 4).

import { useEffect, useRef, type RefObject } from "react";

import { DerivedFigure, Glyph } from "../../../primitives/index.js";
import {
  LEDGER_FIND_CAP_NOTE,
  LEDGER_FIND_SCOPE_NOTE,
  isFindWalkCapped,
  type FindStepDirection,
  type LedgerFindResult,
} from "./find-model.js";

export interface FindInLedgerProps {
  readonly query: string;
  readonly result: LedgerFindResult;
  /** Which match the walk is on, or `-1` before the first step. */
  readonly currentMatchIndex: number;
  /**
   * How many times the caller has asked for this field, monotonic for the mount.
   *
   * The chord that opens the field has to put the caret IN it — the whole point of
   * the chord is that typing goes to the query — and it has to do that again when
   * it is pressed while the field is already up. A mount-only effect covers the
   * first case and not the second, so the caller supplies the press count and the
   * effect keys on it.
   */
  readonly openRequestCount: number;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (direction: FindStepDirection) => void;
  /**
   * Fetch the rows before the window's head.
   *
   * Optional, and its absence is the honest state today: no registered read pages
   * a session's log backwards, so a caller with nothing to call supplies nothing
   * and the affordance is not drawn. The boundary sentence is unaffected — the
   * window is still partial, and saying so is the part that does not depend on
   * anyone being able to do something about it.
   */
  readonly onLoadEarlier?: () => void;
  readonly onClose: () => void;
}

const FIND_GLYPH_SIZE = 14;

/**
 * Take the caret every time the field is asked for, and select what is in it.
 *
 * Selecting rather than only focusing because the second press is the case that
 * needs it: somebody re-running the chord over a field holding an old query is
 * about to replace it, and a caret parked at one end makes them clear it by hand.
 */
function useCaretOnOpen(openRequestCount: number): RefObject<HTMLInputElement | null> {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) {
      return;
    }
    input.focus();
    input.select();
  }, [openRequestCount]);
  return inputRef;
}

export function FindInLedger(props: FindInLedgerProps): React.JSX.Element {
  const { result } = props;
  const inputRef = useCaretOnOpen(props.openRequestCount);
  const hasQuery = result.query.length > 0;
  const hasMatches = result.matches.length > 0;
  const onLoadEarlier = props.onLoadEarlier;

  return (
    <div className="meridian-find" role="search">
      <label className="meridian-find__field">
        <Glyph name="search" size={FIND_GLYPH_SIZE} />
        <span className="meridian-find__label">Find in ledger</span>
        <input
          ref={inputRef}
          className="meridian-find__input"
          type="search"
          value={props.query}
          onChange={(event) => {
            props.onQueryChange(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // The field takes focus when it opens, so it owes a keyboard way out.
              // Without one the chord would be a trap: type, and then reach for the
              // mouse to leave.
              event.preventDefault();
              props.onClose();
              return;
            }
            if (event.key !== "Enter") {
              return;
            }
            // Enter walks forward and Shift+Enter walks back, which is the
            // convention every find field in every editor already teaches.
            event.preventDefault();
            props.onStep(event.shiftKey ? "previous" : "next");
          }}
        />
      </label>

      <span className="meridian-find__count" role="status">
        <DerivedFigure text={matchCountText(result, props.currentMatchIndex)} />
      </span>

      <button
        type="button"
        className="meridian-find__step"
        onClick={() => {
          props.onStep("previous");
        }}
        disabled={!hasMatches}
        aria-label="Previous match"
      >
        <Glyph name="chevron-down" size={FIND_GLYPH_SIZE} />
      </button>
      <button
        type="button"
        className="meridian-find__step"
        onClick={() => {
          props.onStep("next");
        }}
        disabled={!hasMatches}
        aria-label="Next match"
      >
        <Glyph name="chevron-right" size={FIND_GLYPH_SIZE} />
      </button>

      <p className="meridian-find__scope">
        <span>{LEDGER_FIND_SCOPE_NOTE}</span>
        {/* Two boundaries, two sentences: the note above bounds what was searched
            and this bounds what can be stepped through, and only the second one
            depends on how many matches this particular query found. */}
        {isFindWalkCapped(result) ? <span>{LEDGER_FIND_CAP_NOTE}</span> : null}
        {result.hasEarlierRows && onLoadEarlier !== undefined ? (
          <button type="button" className="meridian-find__load-earlier" onClick={onLoadEarlier}>
            Load earlier
          </button>
        ) : null}
      </p>

      <button
        type="button"
        className="meridian-find__close"
        onClick={props.onClose}
        aria-label="Close find"
      >
        <Glyph name="close" size={FIND_GLYPH_SIZE} />
      </button>

      {hasQuery && !hasMatches ? (
        <p className="meridian-find__empty">No loaded row matches that.</p>
      ) : null}
    </div>
  );
}

/**
 * The counter, in the console's own words.
 *
 * Three readings, and each is a different fact: nothing typed, nothing found, and
 * a position within a total.
 *
 * THE DENOMINATOR IS THE SET THE WALK CAN REACH. It used to be `totalMatchCount`,
 * on the reasoning that a capped walk "says so by the two numbers differing" —
 * which it cannot, because only one number was ever rendered. The field read
 * "500 of 700", the next step wrapped to "1 of 700", and matches 501–700 were
 * unreachable with nothing on screen saying the walk was bounded. So the position
 * is of the walkable count, which is this module's own doctrine that a boundary is
 * a member of the result, and the honest uncapped total rides beside it as a
 * second figure exactly when the two differ.
 */
function matchCountText(result: LedgerFindResult, currentMatchIndex: number): string {
  if (result.query.length === 0) {
    return `${String(result.searchedRowCount)} rows loaded`;
  }
  if (result.totalMatchCount === 0) {
    return "No matches";
  }
  const position = currentMatchIndex < 0 ? 1 : currentMatchIndex + 1;
  const walkable = `${String(position)} of ${String(result.matches.length)}`;
  return isFindWalkCapped(result)
    ? `${walkable} (${String(result.totalMatchCount)} matched)`
    : walkable;
}
