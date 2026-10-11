// What the steer box says when the dispatch state refuses to send: the origin its refusals carry
// and the words for each admission refusal.

import { refuse, type Refusal } from "#renderer/lib/refusal/contract.js";
import type { RunControlAdmissionRefusal } from "../run/controls/hooks/useRunControlDispatch.js";

/** The subsystem name every refusal the steer box raises carries. */
export const STEER_REFUSAL_ORIGIN = "steer";

/** What a refused admission says in the box's words; total over the closed reason set. */
export function admissionRefusal(reason: RunControlAdmissionRefusal): Refusal {
  return refuse(STEER_REFUSAL_ORIGIN, reason, ADMISSION_REFUSAL_DETAIL[reason]);
}

const ADMISSION_REFUSAL_DETAIL: Readonly<Record<RunControlAdmissionRefusal, string>> = {
  "in-flight":
    "An earlier steer is still settling, so nothing was sent. What " +
    "you typed is still here — send again once it lands.",
};
