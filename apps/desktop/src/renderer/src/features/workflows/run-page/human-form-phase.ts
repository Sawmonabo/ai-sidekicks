// One phase parked on a person, resolved into the form a person answers it through.

import type { WorkflowPhaseState } from "@renderer/services/wire-shapes/workflow-projection.js";
import type { HumanFormPhase } from "./human-form-mount.js";

/**
 * Why a phase parked on a person cannot be answered from here.
 *
 * `phaseRunId` and `formRevision` are additive-optional on an already-published shape,
 * so their absence means an older daemon rather than a phase without a form — and a
 * resolution composed with either one guessed would be answerable in appearance and
 * unsubmittable in fact. The card says that rather than offering a control that cannot
 * work or, worse, saying nothing and leaving the operator hunting for the form.
 */
export const UNADDRESSABLE_HUMAN_WAIT_DETAIL =
  "This run did not report the handle this phase's form is answered through, so the form cannot be opened here.";

/**
 * One phase parked on a person, resolved where the wire carried both members.
 *
 * `undefined` covers two different phases on purpose — one that is not parked on a
 * person at all, and one that is but arrived without its handle — because the caller
 * separates them by the park it already read, and a second discriminator here would be
 * the same question asked twice.
 */
export function humanFormPhaseFor(
  workflowRunId: string,
  phase: WorkflowPhaseState,
): HumanFormPhase | undefined {
  if (phase.parkReason !== "waiting-human") {
    return undefined;
  }
  const { phaseRunId, formRevision, prompt, inputSchema } = phase;
  return phaseRunId === undefined || formRevision === undefined
    ? undefined
    : {
        workflowRunId,
        phaseRunId,
        phaseId: phase.phaseId,
        formRevision,
        // Spread on the arm that carries one rather than passed as an explicit
        // `undefined`, which `exactOptionalPropertyTypes` refuses — and which would
        // also erase the distinction the mount is built on: the key's PRESENCE is
        // whether the run reported what this phase asks, and a key carrying nothing
        // reads identically to a daemon that reported it as empty.
        //
        // Neither one gates the mount, unlike the two members above it. A run that
        // named no schema still parks a phase somebody has to be told about, and the
        // form composes what it can; a run that named no phase-run handle or no
        // revision has nothing to submit AGAINST, which is a different fact.
        ...(prompt === undefined ? {} : { prompt }),
        ...(inputSchema === undefined ? {} : { inputSchema }),
      };
}
