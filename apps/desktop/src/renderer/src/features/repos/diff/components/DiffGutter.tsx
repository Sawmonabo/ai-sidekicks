import { type DiffLine } from "../model.js";

/** The line-number gutter of one side of a row. */
export function DiffGutter(props: {
  readonly line: DiffLine;
  readonly side: "base" | "head";
}): React.JSX.Element {
  const lineNumber = props.side === "base" ? props.line.baseLineNumber : props.line.headLineNumber;
  return (
    <span className="meridian-diff__gutter">
      <span>{lineNumber === undefined ? "" : String(lineNumber)}</span>
    </span>
  );
}
