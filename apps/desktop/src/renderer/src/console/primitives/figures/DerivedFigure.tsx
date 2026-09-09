// The console's OWN reading — "waiting on you", "three rows collapsed", a relative
// time paired with its absolute.
//
// It is proportional precisely so it cannot be mistaken for something the daemon
// said. Putting a wire number through it is the one misuse worth naming: it strips
// the figure's provenance signature, which `Spec-023 §Console Design (Meridian)`
// rule 4 reserves for the mono class `WireFigure.tsx` beside this one renders.
//
// It offers no `title`, and that absence is deliberate rather than an omission: a
// derived reading is not a formatting of a wire figure, so a slot for "the number
// this is a reading of" would invite one to be put there.

export interface DerivedFigureProps {
  /** The console's own reading. Never a number the daemon sent. */
  readonly text: string;
}

export function DerivedFigure(props: DerivedFigureProps): React.JSX.Element {
  return <span className="meridian-figure meridian-figure--derived">{props.text}</span>;
}
