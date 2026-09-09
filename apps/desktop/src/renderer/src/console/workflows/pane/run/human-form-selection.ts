// Which parked phase's form the run pane has open, out of however many are waiting.
//
// A RUN THAT BRANCHES PARKS MORE THAN ONE PHASE ON A PERSON AT A TIME, and the pane
// used to resolve the first addressable one and mount its form. The other park cards
// said the wait "ends when a participant fills in and submits this phase's form" and
// offered no route to that form, so a parallel run could not be advanced from the pane
// that was showing it — the operator's only move was to answer one branch, wait for the
// snapshot to change, and hope the next one became first.
//
// ONE FORM IS OPEN AT A TIME, AND THE CARDS CHOOSE WHICH. The pane mounts a single
// `HumanFormSlot` — the mount is a seat another plan fills, and two of them side by side
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
// against the port and the run the pane is addressed at — the same pair the run read
// itself is held against — so the render that re-addresses already reads no selection.

import type { GrowthPort, WorkflowPhaseState, WorkflowRunSnapshot } from "../../../bridge/index.js";
import { useSubjectScopedState } from "../../../store/index.js";
import type { HumanFormPhase } from "./slots/human-form-mount.js";

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

/**
 * Every phase this snapshot parks on a person and carries the handle for, in order.
 *
 * Takes the whole snapshot rather than its phases, because a resolution carries the run
 * as well as the phase and the two must come from ONE answer: handed the run separately,
 * a caller could pair a retargeted pane's new run with the phases still on screen from
 * the old one, and every entry in the list would name a phase that run never had.
 *
 * Not exported: the ordering IS the default, so a caller that resolved this list for
 * itself would be a second answer to "which wait is open" beside the hook below.
 */
function humanFormPhasesOf(run: WorkflowRunSnapshot): readonly HumanFormPhase[] {
  return run.phaseStates.flatMap((phase) => {
    const wait = humanFormPhaseFor(run.workflowRunId, phase);
    return wait === undefined ? [] : [wait];
  });
}

/** The form the pane has open, and how a card asks for its own. */
export interface HumanFormSelection {
  /** The phase whose form is mounted, or nothing where no wait is addressable. */
  readonly openForm: HumanFormPhase | undefined;
  /** Whether this phase's form is the open one. */
  readonly isOpen: (phaseId: string) => boolean;
  /** Open this phase's form. A phase that is not an addressable wait resolves away. */
  readonly openFormFor: (phaseId: string) => void;
}

/**
 * Hold which addressable human wait is open, defaulting to the first.
 *
 * The state is the phase ID a person asked for and nothing else. Everything a caller
 * reads is derived from the snapshot it passes in, so the hook cannot hold an answer
 * about a run it is no longer looking at.
 *
 * `undefined` is every unserved read at once — nobody asked, a read is in flight, the
 * port refused — because all three carry the same fact for this hook: there is no run
 * to resolve a wait against. A caller that passed phases without a run could reach
 * that state with a list in hand, which is exactly the pairing the mount forbids.
 *
 * THE ADDRESS AND THE ANSWER ARE BOTH PASSED, and they are not the same input. The
 * port and the run id are what the selection is HELD against — the pair
 * `useWorkflowRunSnapshot` is addressed at, so the two cannot come apart — and the
 * snapshot is what it is RESOLVED against, which exists only on the served arm. The
 * port is in the pair for that hook's own reason: the fixture's scenario switch
 * replaces the bridge and keeps the run id, so a run-only holder would carry a
 * selection made against the previous scenario's phases into the next one.
 *
 * AND `addressedPhaseId` IS THE SEED RATHER THAN A FOURTH SOURCE OF TRUTH. A phase deep
 * link opens this pane already saying which phase it is about, and the honest place for
 * that is where a person's own first choice would have gone: the initial value of the
 * one piece of state this hook holds. It is a SEED and not an override — the very next
 * card a person presses supersedes it, which is right, because they are looking at the
 * pane and the link is not. It re-seeds when the pair the selection is held at moves,
 * so a pane re-addressed at another run takes that run's link and not the previous
 * one's, and the resolution below is unchanged: an addressed phase the run does not park
 * on a person falls back to the first wait exactly as a stale click does, rather than
 * leaving the pane pointing at nothing.
 */
export function useHumanFormSelection(
  growth: GrowthPort,
  workflowRunId: string | undefined,
  run: WorkflowRunSnapshot | undefined,
  addressedPhaseId?: string | undefined,
): HumanFormSelection {
  const { value: requestedPhaseId, publish: requestPhaseId } = useSubjectScopedState<
    string | undefined
  >(growth, workflowRunId, () => addressedPhaseId);
  const waits = run === undefined ? [] : humanFormPhasesOf(run);
  const openForm = waits.find((wait) => wait.phaseId === requestedPhaseId) ?? waits[0];
  return {
    openForm,
    isOpen: (phaseId) => openForm?.phaseId === phaseId,
    openFormFor: requestPhaseId,
  };
}
