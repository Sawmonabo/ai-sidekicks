// The two figure classes, as two components — because the distinction between them
// is the console's most load-bearing typographic claim and a single component with
// a `mono` flag would let a call site get it wrong by omission.
//
// `Spec-023 §Console Design (Meridian)` rule 4: "every wire-true figure — costs,
// counts, SHAs, durations, token totals, timestamps — renders in mono … Mono is the
// signature that a number came from the wire; prose never paraphrases a figure."
//
//   • `WireFigure` carries BOTH classes §The eight rules names, because both come
//     from the wire and both therefore earn the mono signature: a byte-for-byte
//     string (an id, a digest, a state name, an error code, a provider label) and a
//     quantity formatted from the exact wire value through `Intl` (`wire-figures.ts`
//     is the only module allowed to do that formatting). It is selectable, because
//     a digest a person cannot copy is a digest they have to retype.
//   • `DerivedFigure` carries the console's OWN reading — "waiting on you", "three
//     rows collapsed", a relative time paired with its absolute. It is proportional
//     precisely so it cannot be mistaken for something the daemon said. Putting a
//     wire number through it is the one misuse worth naming: it strips the figure's
//     provenance signature.
//
// `title` on `WireFigure` is where the exact wire value goes when the visible text
// is a formatted reading of it — the eight rules require that "no formatted figure
// hides the number the daemon sent". It is an attribute rather than a tooltip
// component because the platform's own tooltip needs no bytes and no render path.

import { formatWireString } from "./wire-figures.js";

export interface WireFigureProps {
  /** The figure as it will be shown — either verbatim, or already `Intl`-formatted. */
  readonly value: string;
  /** The exact wire value, when `value` is a formatted reading of it. */
  readonly title?: string;
}

export function WireFigure(props: WireFigureProps): React.JSX.Element {
  return (
    <span className="meridian-figure meridian-figure--wire" title={props.title}>
      {formatWireString(props.value)}
    </span>
  );
}

export interface DerivedFigureProps {
  /** The console's own reading. Never a number the daemon sent. */
  readonly text: string;
}

export function DerivedFigure(props: DerivedFigureProps): React.JSX.Element {
  return <span className="meridian-figure meridian-figure--derived">{props.text}</span>;
}
