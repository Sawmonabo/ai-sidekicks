// The context-window meter: how full the conversation is.
//
// Always visible at every level, and labelled "conversation" rather than "budget"
// or "usage" — the word is load-bearing. A per-run spend budget is a different
// figure with a different owner, and a meter that said "usage" beside a composer
// would be read as money by half the people who saw it.
//
// THREE THINGS IT WILL NOT DO.
//
//   • It never redraws from a prediction. The bar is the last reading the daemon
//     sent, so a long message being typed moves nothing until a reading arrives.
//   • It never acts on the threshold. Above 80% it adds a sentence and nothing
//     else: automatic compaction is prohibited, and a meter that compacted on a
//     threshold would be the console deciding for the room.
//   • It never renders a partial reading. `usage.context_window_update` has no
//     registered payload variant, so a payload missing a member yields no reading
//     at all and this renders the "not checked" absence — which is a different
//     fact from an empty conversation and is rendered differently (rule 8).
//
// AND IT SAYS WHERE ITS NUMBERS CAME FROM. The registered row carries its own
// provenance and its own exhaustion flag, and both change what the bar MEANS: a
// window size the provider reported is a measurement, one taken from a model default
// or estimated is the console's best available guess, and a provider saying the
// window is full is a fact no ratio has to be derived to believe. So the meter draws
// the same bar and states the grade beside it rather than presenting three different
// kinds of reading as one, and the exceeded arm replaces the near-full hint, because
// advising someone to compact soon is the wrong sentence beside a window that is
// already past its end.
//
// A FIXTURE SHELL, AND THE SEAT BESIDE IT SAYS SO. The meter the usage plan owns
// mounts into `ContextMeterSlot`; this body is what that seat renders while nobody
// has filled it, so the rail is never a blank strip while the owning work is in
// flight. It is DELETED by the PR that mounts the owning body — a shell is not
// superseded quietly, because a shell left in place is a second meter that will
// eventually disagree with the first.

import { Nothing } from "../../../../console/primitives/index.js";
import type { ContextWindowReading } from "../usage-readings.js";
import { ContextMeterReading } from "./ContextMeterReading.js";

export interface ContextMeterProps {
  /** The newest reading, or `undefined` while the daemon has sent none. */
  readonly reading: ContextWindowReading | undefined;
}

export function ContextMeter(props: ContextMeterProps): React.JSX.Element {
  if (props.reading === undefined) {
    return (
      <Nothing
        kind="not-checked"
        title="Conversation fullness has not been reported."
        detail="The meter draws the daemon's own reading and never estimates one from the messages on screen."
      />
    );
  }
  return <ContextMeterReading reading={props.reading} />;
}
