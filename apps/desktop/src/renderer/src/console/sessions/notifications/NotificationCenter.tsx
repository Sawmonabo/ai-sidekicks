// The notification center: one place that answers "what needs me".
//
// Three rules of the notification center and the attention plane decide the shape of
// this file more than the layout does:
//
//   • **It offers no dismiss.** The contract has no dismiss method and no
//     client-writable resolution field, and emission is derived from canonical state
//     rather than from client heuristics — a dismiss-all control would be exactly
//     that heuristic. An item clears when the daemon sets `resolvedAt`; opening one
//     navigates and resolves nothing.
//   • **Mute is global only.** A per-session mute is conceivable, but notification
//     preferences are global in the first release: the global control ships and the
//     per-session control is ABSENT rather than disabled, because a disabled control
//     is a claim that the capability exists.
//   • **It re-filters nothing.** Non-matching events are dropped at the control
//     plane before emission, so a second filter here would be a second authority on
//     a decision already made.
//
// THIS COMPONENT PERFORMS NO READ. It is handed the reading, because the
// all-sessions list beside it takes each row's severity off the same plane and two
// reads would eventually disagree about one question.
//
// The preference controls are absent for the same reason and it is stated on
// screen: `attention.preferenceRead` / `attention.preferenceUpdate` are
// control-plane procedures the console cannot reach, so the center says where mute
// lives rather than drawing a switch that would write nowhere.

import type { AttentionItem } from "../../bridge/index.js";
import { type AttentionReading } from "./attention-plane.js";
import { ProjectionBody } from "./ProjectionBody.js";

export interface NotificationCenterProps {
  /**
   * The projection read's result. The destination performs the read and hands it
   * here, so the center and the all-sessions list read one plane and cannot
   * disagree about what needs a person.
   */
  readonly reading: AttentionReading;
  /** Open the source of one item. Renderer-local navigation; resolves nothing. */
  readonly onOpen?: (item: AttentionItem) => void;
}

export function NotificationCenter(props: NotificationCenterProps): React.JSX.Element {
  return (
    <section className="meridian-attention" aria-label="Attention">
      <header className="meridian-attention__head">
        <h2 className="meridian-attention__title">Needs you</h2>
        <p className="meridian-attention__mute">
          Muting is a single global setting, and it never hides work that is blocking.
        </p>
      </header>
      <ProjectionBody reading={props.reading} onOpen={props.onOpen} />
    </section>
  );
}
