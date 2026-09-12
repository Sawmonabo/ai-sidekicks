// Which step the right pane is showing, and how an activation that RESUMES gets one.
//
// TWO WRITERS AND ONE CELL. The step on screen moves for exactly two reasons — the
// person pressed a rail entry, or this activation asked to resume and the daemon has
// now said where this node got to — and both write the same value. Two cells would
// have to agree about which of them wins, and the answer is always the person.
//
// THE RESUME OPENING IS RESOLVED HERE RATHER THAN AT THE PRESS. The remote-access
// entry point contributes a command whose `run` fires before any state read has
// necessarily answered, so a step chosen there is chosen from a snapshot reporting
// nothing done — which resolves to the first step every time, on a node that may have
// settled two of them. Resume is a first-class state, not a recovery path, and this is
// where it becomes one.
//
// AND IT IS RESOLVED ONCE. Until the read answers, the pane shows the first step
// nothing says is done, which is the same value this latches — so the settle costs no
// visible move. What the latch is for is every read AFTER it: a person who chose the
// relay and is looking at the confirmation must not be moved off it because the
// re-read that followed their own act reported the step done. Keyed on the first
// ANSWERED read of this activation, which is one per mount: the walkthrough remounts
// per activation, so a latch cannot outlive the opening it resolved.
//
// NO READ HAPPENS HERE. This takes the reading the walkthrough already subscribes to
// and answers a question about it; the read itself belongs to the flow, under the
// flow's own generation.

import { useEffect, useState } from "react";

import {
  firstUnresolvedStep,
  ONBOARDING_STEP_IDS,
  RESUME_OPENING,
  type OnboardingOpening,
  type OnboardingStepId,
} from "./step-model.js";

/**
 * Where a resume opening lands on a node with every step settled.
 *
 * The rail's first entry, taken from the id tuple rather than written out, so a
 * reordered rail reorders this too. A finished node is a legitimate state to open the
 * walkthrough in — a person may change where this node relays after the fact — and the
 * footer's own terminal is what tells them it is finished.
 */
const RAIL_FIRST_STEP: OnboardingStepId = ONBOARDING_STEP_IDS[0];

/** The step the pane is on, and the one way to move it. */
export interface OpeningStepBinding {
  readonly openStepId: OnboardingStepId;
  readonly chooseStep: (stepId: OnboardingStepId) => void;
}

/**
 * Resolve one activation's opening against what the daemon says is done.
 *
 * `hasAnsweredRead` is the walkthrough's reading having reached its answered arm, and
 * it is deliberately a boolean rather than the reading itself: what this needs to know
 * is whether the completed set it was handed is the daemon's or the opening zero
 * value, and a module that took the union would be a second reader of a shape the
 * walkthrough already narrows.
 */
export function useOpeningStep(
  opening: OnboardingOpening,
  completed: ReadonlySet<OnboardingStepId>,
  hasAnsweredRead: boolean,
): OpeningStepBinding {
  const [chosenStepId, setChosenStepId] = useState<OnboardingStepId | undefined>(undefined);
  const provisional = resolveOpening(opening, completed);
  useEffect(() => {
    if (chosenStepId !== undefined || !hasAnsweredRead) {
      return;
    }
    setChosenStepId(provisional);
  }, [chosenStepId, hasAnsweredRead, provisional]);
  return { openStepId: chosenStepId ?? provisional, chooseStep: setChosenStepId };
}

/** The step an opening names, reading the completed set only where it has to. */
function resolveOpening(
  opening: OnboardingOpening,
  completed: ReadonlySet<OnboardingStepId>,
): OnboardingStepId {
  return opening === RESUME_OPENING ? (firstUnresolvedStep(completed) ?? RAIL_FIRST_STEP) : opening;
}
