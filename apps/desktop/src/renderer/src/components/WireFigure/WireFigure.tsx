// A figure the daemon sent, wearing the mono provenance signature. Mono marks a value that came
// from the wire; prose never paraphrases a figure.
//
// Both wire classes render here: a byte-for-byte string (an id, digest, state name, error code)
// and a quantity formatted from the exact wire value through `Intl` in `lib/wire/figures.ts`, the
// only module that formats. It is selectable, so a digest can be copied. `DerivedFigure` is a
// separate module so a call site cannot pick the wrong class by omission.
//
// `title` carries the exact wire value when the visible text is a formatted reading of it.

import { formatWireString } from "@renderer/lib/wire/figures.js";

/** Props for `WireFigure`. */
export interface WireFigureProps {
  /** The figure as it will be shown — either verbatim, or already `Intl`-formatted. */
  readonly value: string;
  /** The exact wire value, when `value` is a formatted reading of it. */
  readonly title?: string;
  /**
   * Truncates at the measure inside a row too narrow for the value; use this instead of restyling
   * `.meridian-figure--wire`. The `title` should still carry the whole value.
   */
  readonly truncate?: boolean;
}

/** Renders a wire-supplied figure in mono; `title` exposes the exact wire value. */
export function WireFigure(props: WireFigureProps): React.JSX.Element {
  const className = props.truncate
    ? "meridian-figure meridian-figure--wire meridian-figure--truncate"
    : "meridian-figure meridian-figure--wire";
  return (
    <span className={className} title={props.title}>
      {formatWireString(props.value)}
    </span>
  );
}
