// The one line that says these rows are a demonstration.
//
// WHAT IT IS FOR. The first-sixty-seconds surface opens an unnamed fixture window into
// a scripted session already in flight — several sidekicks, several people, a handoff
// drawing, an approval arriving. Its own governing Never bullet forbids presenting that
// as live and requires the scenario to be labeled, and nothing anywhere in the console
// did: before the demo became the default opening it was reachable only by typing a
// fixture id, and afterwards the launch that asks for nothing is the one most likely to
// be read as a real room.
//
// WHAT IT IS NOT. Not a banner, because nothing has gone wrong and nothing is refused;
// not dismissible, because a claim about what these rows ARE stops being true the
// moment it can be put away, and a person who dismissed it on Monday is the person most
// likely to screenshot the room on Tuesday; and not the watch / start chrome, which is
// a different obligation with controls attached and belongs to whichever lane builds
// the replay scrub beside it.
//
// IT NAMES THE COMPOSITION. `Spec-023`'s absence grammar puts the identifying value in
// the mono face and the console's own words in prose, so the scenario's label travels
// as a wire-shaped figure — it is the id a person passes back on a launch argument —
// and the sentence around it is ours.

import { WireFigure } from "../primitives/index.js";

export interface DemoScenarioMarkProps {
  /** The playing scenario's own short label. */
  readonly scenarioLabel: string;
}

/**
 * The mark. Rendered by the frame only where the demonstration arm holds — the
 * decision is `first-launch.ts`', beside the opening rule that shares its conjunct,
 * because a component that decided when it was needed would be a second rule about
 * which composition is playing.
 */
export function DemoScenarioMark(props: DemoScenarioMarkProps): React.JSX.Element {
  return (
    <p className="meridian-demo-mark" role="note">
      <span className="meridian-demo-mark__lead">Demonstration.</span> These rows are a scripted
      composition, not a live session — <WireFigure value={props.scenarioLabel} />.
    </p>
  );
}
