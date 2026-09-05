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

import type { AttentionItem, AttentionTrigger } from "../../bridge/index.js";
import { type AttentionReading } from "./attention-plane.js";
import { ProjectionBody } from "./ProjectionBody.js";

/**
 * How one trigger reads. Total over the closed six by construction, so a seventh
 * fails to compile here before it can reach a surface that renders it namelessly.
 *
 * The label is the console's own reading of a wire value; the item's `summary` is
 * the projection's own text and is rendered beside it verbatim. Exactly one of the
 * six earns red and a glyph — the one that names a failure — so the two-hue rule
 * holds: amber means a person is needed, red means something failed, and every
 * other trigger carries whichever of those its severity says and no colour of its
 * own.
 */
export const TRIGGER_LABELS: Readonly<Record<AttentionTrigger, string>> = {
  pending_approval: "Waiting on an approval",
  pending_input: "Waiting on your input",
  run_completed: "A run finished",
  run_failed: "A run failed",
  invite_received: "An invitation arrived",
  mention: "You were mentioned",
};

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
