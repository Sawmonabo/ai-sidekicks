// The find field, and the boundary it states.
//
// `Spec-023 §Console Design (Meridian)` §5.15: "A find field over the loaded rows
// with match count, next and previous, and the boundary stated in the field:
// 'searched loaded rows only' with a 'load earlier' affordance. Global search
// across sessions is growth (`SessionSearch`)."
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
// COUNTS ARE THE CONSOLE'S OWN READING, not wire figures: "3 of 17" is derived by
// this console from rows it holds, so it renders proportionally through
// `DerivedFigure` rather than in the mono the daemon's own figures wear (rule 4).

import { DerivedFigure, Glyph } from "../../primitives/index.js";
import { LEDGER_FIND_SCOPE_NOTE, type LedgerFindResult } from "./find-model.js";

export interface FindInLedgerProps {
  readonly query: string;
  readonly result: LedgerFindResult;
  /** Which match the walk is on, or `-1` before the first step. */
  readonly currentMatchIndex: number;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (direction: "next" | "previous") => void;
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

export function FindInLedger(props: FindInLedgerProps): React.JSX.Element {
  const { result } = props;
  const hasQuery = result.query.length > 0;
  const hasMatches = result.matches.length > 0;
  const onLoadEarlier = props.onLoadEarlier;

  return (
    <div className="meridian-find" role="search">
      <label className="meridian-find__field">
        <Glyph name="search" size={FIND_GLYPH_SIZE} />
        <span className="meridian-find__label">Find in ledger</span>
        <input
          className="meridian-find__input"
          type="search"
          value={props.query}
          onChange={(event) => {
            props.onQueryChange(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
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
 * a position within a total. The total is `totalMatchCount` — the honest number —
 * while the walk is over the capped `matches`, so a query with more matches than
 * the walk holds says so by the two numbers differing rather than by a silent
 * truncation.
 */
function matchCountText(result: LedgerFindResult, currentMatchIndex: number): string {
  if (result.query.length === 0) {
    return `${String(result.searchedRowCount)} rows loaded`;
  }
  if (result.totalMatchCount === 0) {
    return "No matches";
  }
  const position = currentMatchIndex < 0 ? 1 : currentMatchIndex + 1;
  return `${String(position)} of ${String(result.totalMatchCount)}`;
}
