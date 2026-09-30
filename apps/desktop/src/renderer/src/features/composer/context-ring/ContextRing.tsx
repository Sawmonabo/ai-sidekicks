// The context-window meter: how full the conversation is. Labeled "conversation", not "budget" or
// "usage", which would read as money. The bar is the last reading the daemon sent, never a
// prediction, and never changes color or adds a sentence with fullness. A payload missing a member
// yields no reading, rendered as the "not checked" absence. It states the provenance grade beside
// the bar, since a provider-reported window is a measurement and a default or estimate is a guess.

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
