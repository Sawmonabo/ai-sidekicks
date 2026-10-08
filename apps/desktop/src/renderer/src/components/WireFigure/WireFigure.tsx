// A figure the wire sent, drawn in mono to mark that it came from the wire. It draws two things:
// a string kept exactly as sent because it is the person's own data (an id, a digest, a path, a
// branch, a file name, a model id, a version), and a quantity read through `Intl` in
// `lib/wire/figures.ts`, the only module that formats. It is selectable, so a digest can be copied.
// It never draws a state, kind, status, mode or code: those reach the screen as words.
// `DerivedFigure` is a separate module so a call site cannot pick the wrong class by omission.
//
// `hoverLabel` says what the visible figure stands for: the exact wire value under a formatted
// reading of a quantity, for a time the time on the machine's own clock with its zone, the whole
// value of a truncated one, or what kind of value it is or whose claim, where nothing beside it
// says so.

import { formatWireString } from "#renderer/lib/wire/figures.js";
import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** Props for `WireFigure`. */
export interface WireFigureProps {
  /** The figure as it will be shown — either verbatim, or already `Intl`-formatted. */
  readonly value: string;
  /**
   * What `value` stands for: the exact wire value under a formatted quantity, a time on the
   * machine's own clock with its zone from `formatZonedDateTime`, the whole of a truncated value,
   * or the value's kind or origin. Never the visible text again where it is shown whole.
   */
  readonly hoverLabel?: string | undefined;
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
