// What an answer to one dispatch MEANS to the form that raised it.
//
// Split from `RunInterventionComposer.tsx` because it is a second job: that file
// renders a form and decides what to send, and this one reads the two answers the
// form can get back — the surface's admission verdict at dispatch time, and the
// daemon's own settled state afterwards — into the three things the form does with
// them. No JSX here, so every arm is drivable from a test with no rendered tree at
// all, which is what the exhaustive tails below are worth.

import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import {
  RUN_CONTROL_REFUSAL_ORIGIN,
  type RunControlOutcome,
} from "../controls/run-control-dispatch.js";
import type { RunControlAdmissionRefusal } from "../controls/run-control-surface.js";

/**
 * What one settled dispatch means to the form that raised it.
 *
 * Three arms rather than landed-or-not, because the two that keep the form open
 * offer different next moves: a refusal is retried by confirming again, while an
 * intervention the daemon has RECORDED and not yet applied would be a second
 * intervention if it were confirmed twice — so that arm latches the confirm and
 * leaves cancel as the way out.
 */
export type ComposerSettlement =
  | { readonly kind: "landed" }
  | { readonly kind: "refused"; readonly notice: ConsoleRefusal }
  | { readonly kind: "recorded"; readonly notice: ConsoleRefusal };

/**
 * Read one settled dispatch the way this form has to act on it.
 *
 * The daemon's own `state` decides, never the presence of a result: `applied` and
 * `degraded` are the two the intervention landed on, and a degraded settlement is a
 * real outcome the run's history renders in full — this form's job there is only to
 * get out of the way. Every other arm keeps the body, and the code a person sees is
 * the daemon's own: `rejectionReason` where the wire sent one, and the wire's state
 * otherwise. Nothing here paraphrases a wire code into console prose.
 */
export function readComposerSettlement(outcome: RunControlOutcome): ComposerSettlement {
  if (outcome.kind === "refused") {
    return { kind: "refused", notice: outcome.refusal };
  }
  if (outcome.kind === "acknowledged") {
    // Pause and resume alone answer with an acknowledgment, and this form composes
    // neither. Reached only if that ever changes, and landing is the honest reading
    // of an acknowledgment.
    return { kind: "landed" };
  }
  const { response } = outcome;
  // Switched on a local rather than on `outcome.response.state` so the exhaustive
  // tail below still has a value to hand `unreadableSettlement`: narrowing the
  // RESPONSE to `never` would leave its `state` unreadable in that branch.
  const settledState = response.state;
  switch (settledState) {
    case "applied":
    case "degraded":
      return { kind: "landed" };
    case "rejected":
      return {
        kind: "refused",
        notice: refuse(
          RUN_CONTROL_REFUSAL_ORIGIN,
          response.rejectionReason ?? settledState,
          "The daemon did not apply this. What you typed is still here — change what it asks for and confirm again, or cancel to close without sending.",
        ),
      };
    case "expired":
      return {
        kind: "refused",
        notice: refuse(
          RUN_CONTROL_REFUSAL_ORIGIN,
          settledState,
          "This intervention expired before it was applied. What you typed is still here — confirm again to raise a new one, or cancel to close.",
        ),
      };
    case "requested":
    case "accepted":
      return {
        kind: "recorded",
        notice: refuse(
          RUN_CONTROL_REFUSAL_ORIGIN,
          settledState,
          "The daemon recorded this intervention and has not applied it yet. Your text is on that record; confirming again would raise a second one, so this control stays latched until you close it.",
        ),
      };
    default:
      return unreadableSettlement(settledState);
  }
}

/**
 * The `satisfies never` tail. A seventh intervention state fails to compile here
 * rather than falling through to a form that neither closes nor says why.
 */
function unreadableSettlement(state: never): ComposerSettlement {
  const unreadable = state satisfies never;
  return {
    kind: "refused",
    notice: refuse(
      RUN_CONTROL_REFUSAL_ORIGIN,
      String(unreadable),
      "The daemon answered with a state this console has no reading for, so nothing here claims the intervention landed. What you typed is still here.",
    ),
  };
}

/**
 * What a refused admission says, in this form's own words.
 *
 * Total over the closed refusal set, so a second reason fails to compile here rather
 * than reaching a participant as an empty sentence beside a form that did nothing.
 */
export function admissionRefusal(reason: RunControlAdmissionRefusal): ConsoleRefusal {
  return refuse(RUN_CONTROL_REFUSAL_ORIGIN, reason, ADMISSION_REFUSAL_DETAIL[reason]);
}

const ADMISSION_REFUSAL_DETAIL: Readonly<Record<RunControlAdmissionRefusal, string>> = {
  "in-flight":
    "An earlier request for this run is still settling, so nothing was sent. What you typed is still here — confirm again once it lands.",
};
