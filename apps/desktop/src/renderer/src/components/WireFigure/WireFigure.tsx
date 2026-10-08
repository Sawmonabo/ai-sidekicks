// A figure the wire sent, drawn in mono to mark that it came from the wire. It draws two things:
// a string kept exactly as sent because it is the person's own data (an id, a digest, a path, a
// branch, a file name, a model id, a version), and a quantity read through `Intl` in
// `lib/wire/figures.ts`, the only module that formats. It is selectable, so a digest can be copied.
// It never draws a state, kind, status, mode or code: those reach the screen as words.
// `DerivedFigure` is a separate module so a call site cannot pick the wrong class by omission.
//
// `hoverLabel` carries the exact wire value when the visible text is a formatted reading of a
// quantity, and for a time the time it stands for on the machine's own clock, with its zone.

import { formatWireString } from "#renderer/lib/wire/figures.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** Props for `WireFigure`. */
export interface WireFigureProps {
  /** The figure as it will be shown — either verbatim, or already `Intl`-formatted. */
  readonly value: string;
  /**
   * The exact wire value, when `value` is a formatted reading of a quantity; for a time, the time
   * it stands for on the machine's own clock with its zone, from `formatZonedDateTime`.
   */
  readonly hoverLabel?: string;
  /**
   * Truncates at the measure inside a row too narrow for the value; use this instead of restyling
   * `.meridian-figure--wire`. The `hoverLabel` should still carry the whole value.
   */
  readonly truncate?: boolean;
}

/**
 * Renders a wire-supplied figure in mono; its hover label shows what the visible reading stands
 * for.
 */
export function WireFigure(props: WireFigureProps): React.JSX.Element {
  const className = props.truncate
    ? "meridian-figure meridian-figure--wire meridian-figure--truncate"
    : "meridian-figure meridian-figure--wire";
  // A label repeating the value keeps a truncated value whole, which the text already speaks.
  return (
    <HoverLabel
      text={props.hoverLabel}
      textIs={props.hoverLabel === props.value ? "visible-text" : "description"}
    >
      <span className={className}>{formatWireString(props.value)}</span>
    </HoverLabel>
  );
}
