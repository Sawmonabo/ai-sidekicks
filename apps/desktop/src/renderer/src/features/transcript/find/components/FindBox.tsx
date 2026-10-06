// The find field. Its counts are the renderer's own reading of rows it holds, so they render
// proportionally through `DerivedFigure` rather than in the mono the daemon's figures wear.

import { DerivedFigure } from "#renderer/components/DerivedFigure/DerivedFigure.js";
import { Glyph } from "#renderer/components/Glyph/Glyph.js";
import { GLYPH_SIZE_CHROME } from "#renderer/styles/glyphs.js";
import { type FindStepDirection, type FindResult } from "../matcher.js";
import { useCaretOnOpen } from "../hooks/useCaretOnOpen.js";

import "./FindBox.css";

/** The query, its result, and the acts the field offers. */
export interface FindBoxProps {
  readonly query: string;
  readonly result: FindResult;
  /** Which match the walk is on, or `-1` before the first step. */
  readonly currentMatchIndex: number;
  /** How many times the caller has asked for this field; the caret moves in on each press. */
  readonly openRequestCount: number;
  readonly onQueryChange: (query: string) => void;
  readonly onStep: (direction: FindStepDirection) => void;
  readonly onClose: () => void;
}

/** The find field: query, match count, step and close controls. */
export function FindBox(props: FindBoxProps): React.JSX.Element {
  const { result } = props;
  const inputRef = useCaretOnOpen(props.openRequestCount);
  const hasMatches = result.matches.length > 0;

  return (
    <div className="meridian-find" role="search">
      <label className="meridian-find__field">
        <Glyph name="search" size={GLYPH_SIZE_CHROME} />
        <span className="meridian-find__label">Find in this session</span>
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
              // The field takes focus when it opens, so it needs a keyboard way out.
              event.preventDefault();
              props.onClose();
              return;
            }
            if (event.key !== "Enter") {
              return;
            }
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
 * The counter text. The position is of `matches.length`, the set the walk can reach, never
 * of the uncapped total.
 */
function matchCountText(result: FindResult, currentMatchIndex: number): string {
  if (result.query.length === 0) {
    return `${String(result.searchedRowCount)} rows loaded`;
  }
  if (result.totalMatchCount === 0) {
    return "No matches";
  }
  const position = currentMatchIndex < 0 ? 1 : currentMatchIndex + 1;
  return `${String(position)} of ${String(result.matches.length)}`;
}
