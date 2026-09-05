import { Glyph } from "../../primitives/index.js";
import { type DiffLine } from "./diff-model.js";

/**
 * The line-number gutter, and the attribution mark when the trailers named
 * somebody.
 *
 * The mark is a glyph with a hover card rather than a name in the gutter, because
 * a name in the gutter costs the measure the diff's content needs, and
 * `DiffToolbar.tsx` puts per-line attribution behind a toggle rather than in the
 * default reading.
 * It is `aria-hidden` only when it is decoration; when it is on, it carries the
 * agent's name as its accessible name so the hover card is not the only way to it.
 */
export function DiffGutter(props: {
  readonly line: DiffLine;
  readonly side: "base" | "head";
  readonly showAttributionMarks: boolean;
}): React.JSX.Element {
  const lineNumber = props.side === "base" ? props.line.baseLineNumber : props.line.headLineNumber;
  const attribution = props.line.agentAttribution;
  const showMark = props.showAttributionMarks && attribution !== undefined;
  return (
    <span className="meridian-diff__gutter">
      <span className="meridian-diff__line-number">
        {lineNumber === undefined ? "" : String(lineNumber)}
      </span>
      {showMark && attribution !== undefined ? (
        <span
          className="meridian-diff__attribution-mark"
          title={`${attribution.agentName} — ${attribution.agentRunId}`}
        >
          <Glyph
            name="agent"
            size={DIFF_GUTTER_GLYPH_SIZE}
            title={`Attributed to ${attribution.agentName}`}
          />
        </span>
      ) : null}
    </span>
  );
}

/** Glyph edge length in the gutter, where the mark sits beside a line number. */
export const DIFF_GUTTER_GLYPH_SIZE = 10;
