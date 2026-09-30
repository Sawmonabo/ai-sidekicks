// The context-window meter: how full the conversation is.
//
// Always visible at every level, and labeled "conversation" rather than "budget"
// or "usage" — the word is load-bearing. A per-run spend budget is a different
// figure with a different owner, and a meter that said "usage" beside a composer
// would be read as money by half the people who saw it.
//
// THREE THINGS IT WILL NOT DO.
//
//   • It never redraws from a prediction. The bar is the last reading the daemon
//     sent, so a long message being typed moves nothing until a reading arrives.
//   • It never changes color or adds a sentence with fullness. The meter is one figure
//     and one bar, and a meter that acted on a threshold would be the console
//     deciding for the room.
//   • It never renders a partial reading. `usage.context_window_update` has no
//     registered payload variant, so a payload missing a member yields no reading
//     at all and this renders the "not checked" absence — which is a different
//     fact from an empty conversation and is rendered differently.
//
// AND IT SAYS WHERE ITS NUMBERS CAME FROM. The registered row carries its own
// provenance, which changes what the bar MEANS: a window size the provider reported is
// a measurement, and one taken from a model default or estimated is the console's best
// available guess. So the meter draws the same bar and states the grade beside it
// rather than presenting different kinds of reading as one.

import { Nothing } from "@renderer/components/Nothing/Nothing.js";
import type { ContextWindowReading } from "./context-window-reading.js";
import { ContextRingReading } from "./ContextRingReading.js";

/** What the meter draws. */
export interface ContextRingProps {
  /** The newest reading, or `undefined` while the daemon has sent none. */
  readonly reading: ContextWindowReading | undefined;
}

/** The newest context reading as a bar and figures, or the not-checked absence. */
export function ContextRing(props: ContextRingProps): React.JSX.Element {
  if (props.reading === undefined) {
    return (
      <Nothing
        kind="not-checked"
        title="Conversation fullness has not been reported."
        detail="The meter draws the background service's own reading and never estimates one from the messages on screen."
      />
    );
  }
  return <ContextRingReading reading={props.reading} />;
}
