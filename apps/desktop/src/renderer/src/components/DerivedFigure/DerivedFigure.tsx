// The app's own reading, in the proportional class so it is not mistaken for a wire figure.
// `hoverLabel` carries what the reading stands for, as `WireFigure`'s does: for a time the app
// read off the window's own clock, that time with its zone.

import { HoverLabel } from "#renderer/components/HoverLabel/HoverLabel.js";

/** Props for `DerivedFigure`. */
export interface DerivedFigureProps {
  /** The app's own reading. Never a number the daemon sent. */
  readonly text: string;
  /** What the reading stands for, when the text is a formatted reading of it. */
  readonly hoverLabel?: string;
}

/**
 * The app's own reading, such as "waiting on you". Never pass a wire number through it:
 * that strips the mono signature `WireFigure` gives it.
 */
export function DerivedFigure(props: DerivedFigureProps): React.JSX.Element {
  return (
    <HoverLabel
      text={props.hoverLabel}
      textIs={props.hoverLabel === props.text ? "visible-text" : "description"}
    >
      <span className="meridian-figure meridian-figure--derived">{props.text}</span>
    </HoverLabel>
  );
}
