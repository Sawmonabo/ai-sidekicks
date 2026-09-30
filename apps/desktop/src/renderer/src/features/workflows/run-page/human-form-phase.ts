// One phase parked on a person, resolved into the form a person answers it through.

import type { WorkflowPhaseState } from "@renderer/services/wire-shapes/workflow-projection.js";
import type { HumanFormPhase } from "./human-form-mount.js";

/**
 * Why a phase parked on a person cannot be answered from here.
 *
 * A run read may omit `phaseRunId` and `formRevision`; a resolution composed with either
 * guessed would look answerable and fail to submit, so the card says so instead.
 *
 * @consumedBy the run page's parked-on-a-person card
 */
export const UNADDRESSABLE_HUMAN_WAIT_DETAIL =
  "This run did not report the handle this phase's form is answered through, so the form cannot be opened here.";

/**
 * One phase parked on a person, resolved where the wire carried both members.
 *
 * `undefined` covers a phase that is not parked on a person and one that is but arrived
 * without its handle; the caller tells them apart by the park it already read.
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
        // Spread on the arm that has one, since key presence is whether the run reported it
        // (`exactOptionalPropertyTypes` refuses an explicit `undefined`). Neither gates the mount.
        ...(prompt === undefined ? {} : { prompt }),
        ...(inputSchema === undefined ? {} : { inputSchema }),
      };
}
