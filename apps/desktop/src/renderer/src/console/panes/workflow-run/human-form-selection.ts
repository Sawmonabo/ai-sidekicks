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

import { useState } from "react";

import type { WorkflowPhaseState } from "../../bridge/index.js";
import type { HumanFormMount } from "./slots/HumanFormSlot.js";

/**
 * Why a phase parked on a person cannot be answered from here.
 *
 * `phaseRunId` and `formRevision` are additive-optional on an already-published shape,
 * so their absence means an older daemon rather than a phase without a form — and a
 * mount composed with either one guessed would be answerable in appearance and
 * unsubmittable in fact. The card says that rather than offering a control that cannot
 * work or, worse, saying nothing and leaving the operator hunting for the form.
 */
export const UNADDRESSABLE_HUMAN_WAIT_DETAIL =
  "This run did not report the handle this phase's form is answered through, so the form cannot be opened here.";

/**
 * The mount for one phase parked on a person, where the wire carried both members.
 *
 * `undefined` covers two different phases on purpose — one that is not parked on a
 * person at all, and one that is but arrived without its handle — because the caller
 * separates them by the park it already read, and a second discriminator here would be
 * the same question asked twice.
 */
export function humanFormMountFor(phase: WorkflowPhaseState): HumanFormMount | undefined {
  if (phase.parkReason !== "waiting-human") {
    return undefined;
  }
  const { phaseRunId, formRevision } = phase;
  return phaseRunId === undefined || formRevision === undefined
    ? undefined
    : { phaseRunId, phaseId: phase.phaseId, formRevision };
}

/**
 * Every phase this snapshot parks on a person and carries the handle for, in order.
 *
 * Not exported: the ordering IS the default, so a caller that resolved this list for
 * itself would be a second answer to "which wait is open" beside the hook below.
 */
function humanFormMountsOf(phases: readonly WorkflowPhaseState[]): readonly HumanFormMount[] {
  return phases.flatMap((phase) => {
    const mount = humanFormMountFor(phase);
    return mount === undefined ? [] : [mount];
  });
}

/** The form the pane has open, and how a card asks for its own. */
export interface HumanFormSelection {
  /** The phase whose form is mounted, or nothing where no wait is addressable. */
  readonly openForm: HumanFormMount | undefined;
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
 */
export function useHumanFormSelection(phases: readonly WorkflowPhaseState[]): HumanFormSelection {
  const [requestedPhaseId, setRequestedPhaseId] = useState<string | undefined>(undefined);
  const mounts = humanFormMountsOf(phases);
  const openForm = mounts.find((mount) => mount.phaseId === requestedPhaseId) ?? mounts[0];
  return {
    openForm,
    isOpen: (phaseId) => openForm?.phaseId === phaseId,
    openFormFor: setRequestedPhaseId,
  };
}
