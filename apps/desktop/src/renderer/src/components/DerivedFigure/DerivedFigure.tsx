// The console's own reading, in the proportional class so it is not mistaken for a wire figure.

/** Props for `DerivedFigure`; there is deliberately no `title`, so no wire value can hide here. */
export interface DerivedFigureProps {
  /** The console's own reading. Never a number the daemon sent. */
  readonly text: string;
}

/**
 * The console's own reading, such as "waiting on you". Never pass a wire number through it:
 * that strips the mono signature `WireFigure` gives it.
 */
export function DerivedFigure(props: DerivedFigureProps): React.JSX.Element {
  return <span className="meridian-figure meridian-figure--derived">{props.text}</span>;
}
