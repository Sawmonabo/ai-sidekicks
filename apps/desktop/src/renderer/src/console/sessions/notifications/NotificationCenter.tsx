// The notification center: one place that answers "what needs me".
//
// `Spec-023 §Console Design (Meridian)` §Notification center and the attention
// plane. Three of its rules decide the shape of this file more than the layout
// does:
//
//   • **It offers no dismiss.** The contract has no dismiss method and no
//     client-writable resolution field, and `Spec-019 §Required Behavior` makes
//     emission derived from canonical state rather than from client heuristics — a
//     dismiss-all control would be exactly that heuristic. An item clears when the
//     daemon sets `resolvedAt`; opening one navigates and resolves nothing.
//   • **Mute is global only.** `Spec-023 §Default Behavior` allows a per-session
//     mute and `Spec-019 §Resolved Questions and V1 Scope Decisions` makes
//     preferences global in the first release. The conflict resolves to the
//     notification owner: the global control ships and the per-session control is
//     ABSENT rather than disabled, because a disabled control is a claim that the
//     capability exists.
//   • **It re-filters nothing.** Non-matching events are dropped at the control
//     plane before emission (`Spec-019 §Desktop-to-Desktop Delivery`), so a second
//     filter here would be a second authority on a decision already made.
//
// WHAT IS ON SCREEN TODAY. The projection read (`attention.projectionRead`) is
// registered in the corpus and absent from `packages/contracts`, from the preload
// bridge, and from the growth port — so the destination reads through
// `READS_NO_ATTENTION_PROJECTION`, which answers "nothing was read", and the
// honest render of that is the `not-checked` kind of nothing rather than the
// all-clear line. Those two are the conflation the five kinds of nothing exist to
// prevent: one says the console did not ask, the other says a person is free.
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
import { type OsNotificationDelivery } from "./os-notification-delivery.js";
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
  /**
   * Re-open the projection read after a refusal. Reaches the refused phase alone.
   *
   * Optional for {@link NotificationCenterProps.onOpen}'s reason: the center is
   * mounted in two harnesses that hold no read, and only the destination that
   * performs one can offer a way back into it.
   */
  readonly onReopen?: () => void;
  /**
   * Whether an OS notification would reach a person on this machine.
   *
   * Optional for {@link NotificationCenterProps.onOpen}'s reason — the centre is
   * mounted in harnesses that perform no read — and an absent one is treated exactly
   * as an unread one: the centre says nothing about a fact nobody established.
   */
  readonly delivery?: OsNotificationDelivery;
}

export function NotificationCenter(props: NotificationCenterProps): React.JSX.Element {
  return (
    <section className="meridian-attention" aria-label="Attention">
      <header className="meridian-attention__head">
        <h2 className="meridian-attention__title">Needs you</h2>
        <p className="meridian-attention__mute">
          Muting is a single global setting, and it never hides work that is blocking.
        </p>
        {props.delivery?.status === "withheld" ? (
          <p className="meridian-attention__only-surface">
            This machine will not show notifications for this application, so nothing below leaves
            this window. This panel is the only place these items reach you.
          </p>
        ) : null}
      </header>
      <ProjectionBody reading={props.reading} onOpen={props.onOpen} onReopen={props.onReopen} />
    </section>
  );
}
