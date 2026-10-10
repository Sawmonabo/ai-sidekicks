import { type DiffLine } from "../model.js";
import type { IntralineReading } from "../intraline/segment-cache.js";
import { DiffGutter } from "./DiffGutter.js";
import { DiffLineText } from "./DiffLineText.js";

/**
 * One side of a split row. The ground weight is painted on the cell, not the row, because a
 * paired row holds a deletion and an insertion and a row modifier would paint both sides in
 * one. An absent line renders an empty cell with its gutter, so the sides stay in column.
 */
export function DiffSplitCell(props: {
  readonly line: DiffLine | undefined;
  /** Absent exactly where the line is: an empty cell has nothing to segment. */
  readonly reading: IntralineReading | undefined;
  readonly side: "base" | "head";
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
      <DiffGutter line={line} side={props.side} />
      <DiffLineText line={line} reading={reading} look="review" />
    </span>
  );
}
