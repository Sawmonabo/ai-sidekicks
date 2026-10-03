// One phase parked on a person, resolved into the form a person answers it through.

import type { WorkflowPhaseState } from "@renderer/services/wire-shapes/workflow-projection.js";
import type { HumanFormPhase } from "./human-form-mount.js";

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
