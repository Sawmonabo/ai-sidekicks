import { type DiffLine } from "./diff-model.js";
import type { IntralineReading } from "./intraline-segments.js";
import { DiffGutter } from "./DiffGutter.js";
import { DiffLineText } from "./DiffLineText.js";

/**
 * One side of a split row.
 *
 * THE GROUND WEIGHT IS PAINTED HERE AND NOT ON THE ROW. A paired row holds a
 * deletion and an insertion at once, so a single modifier on the row would have
 * to name one of two kinds — and would paint the whole width in it. The kind
 * modifier rides the CELL, in both layouts, so the unified row keeps exactly the
 * ground it had (its one cell fills the row) and a split row paints each side
 * its own.
 *
 * An absent line renders an empty cell that still occupies its gutter, so the
 * two sides stay in column even where only one of them has a line.
 */
export function DiffSplitCell(props: {
  readonly line: DiffLine | undefined;
  /** Absent exactly where the line is: an empty cell has nothing to segment. */
  readonly reading: IntralineReading | undefined;
  readonly side: "base" | "head";
  readonly showAttributionMarks: boolean;
  readonly showWhitespaceChanges: boolean;
}): React.JSX.Element {
  const { line } = props;
  const className = [
    "meridian-diff__side",
    `meridian-diff__side--${props.side}`,
    line === undefined ? "" : `meridian-diff__side--${line.kind}`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  const { reading } = props;
  if (line === undefined || reading === undefined) {
    return (
      <span className={className} role="cell">
        <span className="meridian-diff__gutter" />
        <span className="meridian-diff__text" />
      </span>
    );
  }
  return (
    <span className={className} role="cell">
      <DiffGutter line={line} side={props.side} showAttributionMarks={props.showAttributionMarks} />
      <DiffLineText
        line={line}
        reading={reading}
        showWhitespaceChanges={props.showWhitespaceChanges}
      />
    </span>
  );
}
