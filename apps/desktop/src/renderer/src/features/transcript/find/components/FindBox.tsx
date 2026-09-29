// The find field.
//
// `find-model.ts` owns the rule this field renders: find runs over the loaded rows with
// a match count and next and previous.
//
// Counts are the renderer's own reading, not wire figures: "3 of 17" is derived from rows
// it holds, so it renders proportionally through `DerivedFigure` rather than in the mono
// the daemon's own figures wear.

import { DerivedFigure, Glyph } from "@renderer/console/primitives/index.js";
import { GLYPH_SIZE_CHROME } from "@renderer/styles/glyphs.js";
import { type FindStepDirection, type LedgerFindResult } from "../find-model.js";
import { useCaretOnOpen } from "../hooks/useCaretOnOpen.js";

import "./find-box.css";

/** The query, its result, and the acts the field offers. */
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
  readonly onClose: () => void;
}

/** The find field: query, match count, step and close controls. */
export function FindInLedger(props: FindInLedgerProps): React.JSX.Element {
  const { result } = props;
  const inputRef = useCaretOnOpen(props.openRequestCount);
  const hasMatches = result.matches.length > 0;

  return (
    <div className="meridian-find" role="search">
      <label className="meridian-find__field">
        <Glyph name="search" size={GLYPH_SIZE_CHROME} />
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
        <Glyph name="chevron-down" size={GLYPH_SIZE_CHROME} />
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
        <Glyph name="chevron-right" size={GLYPH_SIZE_CHROME} />
      </button>

      <button
        type="button"
        className="meridian-find__close"
        onClick={props.onClose}
        aria-label="Close find"
      >
        <Glyph name="close" size={GLYPH_SIZE_CHROME} />
      </button>
    </div>
  );
}

/**
 * The counter, in the console's own words.
 *
 * Three readings, and each is a different fact: nothing typed, nothing found, and
 * a position within a total.
 *
 * THE DENOMINATOR IS THE SET THE WALK CAN REACH: the position is of the walkable
 * count, so a step never wraps into a total that contains matches no press could
 * reach.
 */
function matchCountText(result: LedgerFindResult, currentMatchIndex: number): string {
  if (result.query.length === 0) {
    return `${String(result.searchedRowCount)} rows loaded`;
  }
  if (result.totalMatchCount === 0) {
    return "No matches";
  }
  const position = currentMatchIndex < 0 ? 1 : currentMatchIndex + 1;
  return `${String(position)} of ${String(result.matches.length)}`;
}
