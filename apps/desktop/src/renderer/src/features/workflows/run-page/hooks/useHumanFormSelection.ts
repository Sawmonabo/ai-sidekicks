// Which parked phase's form the run pane has open, out of however many are waiting.
//
// A RUN THAT BRANCHES PARKS MORE THAN ONE PHASE ON A PERSON AT A TIME, and the pane
// used to resolve the first addressable one and mount its form. The other park cards
// said the wait "ends when a user fills in and submits this phase's form" and
// offered no route to that form, so a parallel run could not be advanced from the pane
// that was showing it — the operator's only move was to answer one branch, wait for the
// snapshot to change, and hope the next one became first.
//
// ONE FORM IS OPEN AT A TIME, AND THE CARDS CHOOSE WHICH. The pane mounts a single
// `HumanFormMountPoint` — the mount is a seat another plan fills, and two of them side by side
// would be two bodies composed against two revisions in one column of chrome — so the
// selection is a phase id and every addressable card carries the action that sets it.
// Nothing is hidden by the choice: every park still renders its own card, and the card
// says whether its form is the one open.
//
// THE DEFAULT IS THE FIRST ADDRESSABLE WAIT AND THE SELECTION IS RESOLVED, NOT STORED.
// A selection is a phase id held against a snapshot that changes underneath it, so the
// open form is resolved from the CURRENT phases each render: a phase that has since
// resumed, or whose park has gone, falls back to the first wait still standing rather
// than leaving the pane pointing at nothing. That is why no effect resets this state and
// why a stale id can never open a form composed against a phase the run has moved past.
//
// RESOLVED IS NOT SCOPED, AND THE SELECTION NEEDED BOTH. Resolution makes a stale id
// SAFE — it can only ever pick out a wait the current snapshot still has — and says
// nothing about which RUN the person was answering about. Phase ids are the
// definition's, so a pane retargeted from run A to run B without unmounting resolved
// A's `sign-off` against B's phases, found the same id there, and opened run B's
// `sign-off` form for somebody who had asked to see run A's. The id is therefore held
// against the run the pane is addressed at — the same run the run read itself is held
// against — so the render that re-addresses already reads no selection.

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
 * The state is the phase ID a person asked for and nothing else. Everything a caller
 * reads is derived from the snapshot it passes in, so the hook cannot hold an answer
 * about a run it is no longer looking at.
 *
 * `undefined` is every unserved read at once — nobody asked, a read is in flight —
 * because both carry the same fact for this hook: there is no run to resolve a wait
 * against. A caller that passed phases without a run could reach that state with a list
 * in hand, which is exactly the pairing the mount forbids.
 *
 * THE ADDRESS AND THE ANSWER ARE BOTH PASSED, and they are not the same input. The run
 * id is what the selection is HELD against — the id `useWorkflowRunSnapshot` is
 * addressed at, so the two cannot come apart — and the snapshot is what it is RESOLVED
 * against, which exists only on the served arm.
 *
 * A requested phase the run does not park on a person falls back to the first wait, so
 * a stale press lands on the run rather than on nothing.
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
 * Takes the whole snapshot rather than its phases, because a resolution carries the run
 * as well as the phase and the two must come from ONE answer: handed the run separately,
 * a caller could pair a retargeted pane's new run with the phases still on screen from
 * the old one, and every entry in the list would name a phase that run never had.
 *
 * Not exported: the ordering IS the default, so a caller that resolved this list for
 * itself would be a second answer to "which wait is open" beside the hook above.
 */
function humanFormPhasesOf(run: WorkflowRunSnapshot): readonly HumanFormPhase[] {
  return run.phaseStates.flatMap((phase) => {
    const wait = humanFormPhaseFor(run.workflowRunId, phase);
    return wait === undefined ? [] : [wait];
  });
}
