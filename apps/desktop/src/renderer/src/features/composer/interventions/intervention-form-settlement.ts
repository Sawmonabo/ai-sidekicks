// Reads what a dispatch answer means to the steer form: the admission verdict and the daemon's
// settled state become three form outcomes. No JSX, so each arm is testable directly.

import { refuse, type Refusal } from "#renderer/lib/refusal/refusal.js";
import type { RunControlOutcome } from "../run-controls/services/run-control-dispatch.js";
import type { RunControlAdmissionRefusal } from "../run-controls/hooks/useRunControlDispatch.js";

/** The subsystem name every refusal this form raises carries. */
export const RUN_INTERVENTION_REFUSAL_ORIGIN = "run-intervention";

/**
 * What one settled dispatch means to the form. A refusal is retried by confirming again; an
 * intervention recorded and not yet applied would be doubled by a second confirm, so that arm
 * latches the confirm and leaves cancel as the way out.
 */
export type InterventionFormSettlement =
  | { readonly kind: "landed" }
  | { readonly kind: "refused"; readonly notice: Refusal }
  | { readonly kind: "recorded"; readonly notice: Refusal };

/**
 * Reads one settled dispatch as the form must act on it. The daemon's `state` decides, never
 * the presence of a result: `applied` and `degraded` landed; every other arm keeps the body
 * and shows the daemon's own code (`rejectionReason`, else the state).
 */
export function readInterventionFormSettlement(
  outcome: RunControlOutcome,
): InterventionFormSettlement {
  if (outcome.kind === "acknowledged") {
    // Only pause and resume are acknowledged and this form sends neither; read as landed.
    return { kind: "landed" };
  }
  const { response } = outcome;
  const settledState = response.state;
  switch (settledState) {
    case "applied":
    case "degraded":
      return { kind: "landed" };
    case "rejected":
      return {
        kind: "refused",
        notice: refuse(
          RUN_INTERVENTION_REFUSAL_ORIGIN,
          response.rejectionReason ?? settledState,
          REJECTED_DETAIL,
        ),
      };
    case "expired":
      return {
        kind: "refused",
        notice: refuse(
          RUN_INTERVENTION_REFUSAL_ORIGIN,
          settledState,
          "This intervention expired before it was applied. What you typed " +
            "is still here — confirm again to raise a new one, or cancel to " +
            "close.",
        ),
      };
    case "requested":
    case "accepted":
      return {
        kind: "recorded",
        notice: refuse(
          RUN_INTERVENTION_REFUSAL_ORIGIN,
          settledState,
          "The background service recorded this intervention and has not " +
            "applied it yet. Your text is on that record; confirming again " +
            "would raise a second one, so this control stays latched until " +
            "you close it.",
        ),
      };
  }
}

/** What a refused admission says in the form's words; total over the closed reason set. */
export function admissionRefusal(reason: RunControlAdmissionRefusal): Refusal {
  return refuse(RUN_INTERVENTION_REFUSAL_ORIGIN, reason, ADMISSION_REFUSAL_DETAIL[reason]);
}

/** What the form says beside a rejected settlement; the wire cause is the refusal's code. */
const REJECTED_DETAIL =
  "The background service did not apply this. What you typed is " +
  "still here — change what it asks for and confirm again, or " +
  "cancel to close without sending.";

const ADMISSION_REFUSAL_DETAIL: Readonly<Record<RunControlAdmissionRefusal, string>> = {
  "in-flight":
    "An earlier request for this run is still settling, so nothing " +
    "was sent. What you typed is still here — confirm again once it " +
    "lands.",
};
