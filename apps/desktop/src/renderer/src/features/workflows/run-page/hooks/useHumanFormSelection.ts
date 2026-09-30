// Which parked phase's form the run pane has open, out of however many are waiting.
// The pane mounts one form at a time. The selection is a phase id held against the run the
// pane is addressed at and resolved from the current phases on every render: a stale id
// falls back to the first wait, and a retarget to another run reads no selection.

import type { WorkflowRunSnapshot } from "@renderer/services/wire-shapes/workflow-projection.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import type { HumanFormPhase } from "../human-form-mount.js";
import { humanFormPhaseFor } from "../human-form-phase.js";

/** The form the pane has open, and how a card asks for its own. */
export interface HumanFormSelection {
  /** The phase whose form is mounted, or nothing where no wait is addressable. */
  readonly openForm: HumanFormPhase | undefined;
  /** Whether this phase's form is the open one. */
  readonly isOpen: (phaseId: string) => boolean;
  /** Open this phase's form. A phase that is not an addressable wait resolves away. */
  readonly openFormFor: (phaseId: string) => void;
}

/** The subject the selection is held against, so the run id alone re-addresses it. */
const SELECTION_SUBJECT = {};

/**
 * Hold which addressable human wait is open, defaulting to the first.
 *
 * Held against `workflowRunId` and resolved against `run` (`undefined` until served); a
 * requested phase the run does not park on a person falls back to the first wait.
 */
export function useHumanFormSelection(
  workflowRunId: string | undefined,
  run: WorkflowRunSnapshot | undefined,
): HumanFormSelection {
  const { value: requestedPhaseId, publish: requestPhaseId } = useSubjectScopedState<
    string | undefined
  >(SELECTION_SUBJECT, workflowRunId, () => undefined);
  const waits = run === undefined ? [] : humanFormPhasesOf(run);
  const openForm = waits.find((wait) => wait.phaseId === requestedPhaseId) ?? waits[0];
  return {
    openForm,
    isOpen: (phaseId) => openForm?.phaseId === phaseId,
    openFormFor: requestPhaseId,
  };
}

/**
 * Every phase this snapshot parks on a person and carries the handle for, in order.
 *
 * Takes the whole snapshot so the run and its phases come from one answer. Not exported:
 * the order is the default selection, so a second resolver would be a second answer.
 */
function humanFormPhasesOf(run: WorkflowRunSnapshot): readonly HumanFormPhase[] {
  return run.phaseStates.flatMap((phase) => {
    const wait = humanFormPhaseFor(run.workflowRunId, phase);
    return wait === undefined ? [] : [wait];
  });
}
