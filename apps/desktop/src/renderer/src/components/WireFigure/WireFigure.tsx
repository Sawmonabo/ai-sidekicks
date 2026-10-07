// A figure the wire sent, drawn in mono to mark that it came from the wire. It draws two things:
// a string kept exactly as sent because it is the person's own data (an id, a digest, a path, a
// branch, a file name, a model id, a version), and a quantity read through `Intl` in
// `lib/wire/figures.ts`, the only module that formats. It is selectable, so a digest can be copied.
// It never draws a state, kind, status, mode or code: those reach the screen as words.
// `DerivedFigure` is a separate module so a call site cannot pick the wrong class by omission.
//
// `title` carries the exact wire value when the visible text is a formatted reading of it.

import { formatWireString } from "#renderer/lib/wire/figures.js";

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
