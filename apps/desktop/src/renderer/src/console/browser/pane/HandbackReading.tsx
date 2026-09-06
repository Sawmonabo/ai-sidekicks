// What the keyboard handback is doing, said where the pane keeps its standing readings.
//
// `Spec-023 §Console Design (Meridian)` 12.4 has two halves and both of them run
// without anyone asking: the console publishes its chord mirror when the chord table
// changes, and the host hands claimed chords back over a subscription opened at mount.
// So neither half's outcome is an answer to an act, and neither belongs in the pane's
// refusal banner — which is reserved for the newest thing a person did.
//
// THREE STATES AND NO FOURTH. The mirror was refused, so nothing is claimed and the
// person needs to know that a console chord pressed in the page will do nothing here.
// The chord table was unreadable, which is 12.4's degraded arm: publishing nothing is
// the safe direction, and the surface says so rather than showing an empty claim. Or
// the mirror stands, and the reading names how many chords it claims and how many have
// come back — the second figure is what turns "we published something" into evidence
// that the wire between the page and this window is carrying keystrokes.

import { DerivedFigure, formatCount, InlineRefusal, Nothing } from "../../primitives/index.js";
import type { HandbackBinding } from "./handback-binding.js";

export interface HandbackReadingProps {
  readonly handback: HandbackBinding;
}

export function HandbackReading(props: HandbackReadingProps): React.JSX.Element {
  const { mirrorChords, refusal, replayCount } = props.handback;
  if (refusal !== undefined) {
    return <InlineRefusal {...refusal} />;
  }
  if (mirrorChords === undefined) {
    return (
      <Nothing
        kind="not-checked"
        placement="inline"
        title="No chord is claimed from the page"
        detail="This window's chord table could not be read, so nothing was published to the page host and every keystroke reaches the page — which is the safe direction."
      />
    );
  }
  return (
    // No live region. The replay count moves every time a claimed chord comes back,
    // and announcing each one would read the running total aloud during typing.
    <p className="meridian-browser-region__note">
      <DerivedFigure text={`${formatCount(mirrorChords.length)} chords`} /> are claimed from the
      page and handed back to this window.{" "}
      <DerivedFigure text={`${formatCount(replayCount)} replayed`} /> so far.
    </p>
  );
}
