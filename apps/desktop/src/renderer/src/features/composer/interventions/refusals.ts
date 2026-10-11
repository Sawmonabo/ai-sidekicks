// What the steer form says when the dispatch state refuses to send: the origin its refusals carry
// and the words for each admission refusal.

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { RunControlAdmissionRefusal } from "../run/controls/hooks/useRunControlDispatch.js";

/** The subsystem name every refusal this form raises carries. */
export const RUN_INTERVENTION_REFUSAL_ORIGIN = "run-intervention";

/** What a refused admission says in the form's words; total over the closed reason set. */
export function admissionRefusal(reason: RunControlAdmissionRefusal): Refusal {
  return refuse(RUN_INTERVENTION_REFUSAL_ORIGIN, reason, ADMISSION_REFUSAL_DETAIL[reason]);
}

const ADMISSION_REFUSAL_DETAIL: Readonly<Record<RunControlAdmissionRefusal, string>> = {
  "in-flight":
    "An earlier request for this run is still settling, so nothing " +
    "was sent. What you typed is still here — confirm again once it " +
    "lands.",
};
