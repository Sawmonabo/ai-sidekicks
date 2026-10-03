// Answering a phase parked on a person: what a press puts and what the answer settles to.
// The call is the caller's and a rejected call is not caught here. The outcome is scoped to
// `phaseRunId`, not the run, so one branch's refusal never lands on another branch's form.
// The daemon alone decides eligibility and staleness.

import { refuse, type Refusal } from "@renderer/lib/refusal.js";
import { useGenerationLatch } from "@renderer/hooks/useGenerationLatch.js";
import { type GenerationClaim } from "@renderer/lib/reads/generation-latch.js";
import { useSubjectScopedState } from "@renderer/hooks/subject-scoped/useSubjectScopedState.js";
import { useRecordServedRunAct } from "./useRecordServedRunAct.js";
import type { HumanFormPhase } from "../human-form-mount.js";
import {
  WORKFLOW_HUMAN_FORM_ORIGIN,
  submittableFields,
  type WorkflowHumanFormDispatch,
  type WorkflowHumanFormFields,
  type WorkflowHumanFormOutcome,
  type WorkflowHumanFormRefusalCode,
  type WorkflowHumanFormSubmitCall,
} from "../human-form-submit.js";

/**
 * One attempt at one phase's form: the revision it was composed against, and where it got to.
 *
 * Both facts share one holder so a single key decides when an attempt begins; every later
 * write carries the revision through untouched.
 */
interface WorkflowHumanFormAttempt {
  /** The `formRevision` the run read carried when this attempt's form opened. */
  readonly composedAgainstRevision: number;
  /** Where the last press got to, or `idle` while there has been none. */
  readonly outcome: WorkflowHumanFormOutcome;
}

/** Nobody has answered this phase yet, which is where every form opens. */
const IDLE: WorkflowHumanFormOutcome = { kind: "idle" };

/**
 * Offer one waiting phase's submit, dispatching it through the caller's call.
 *
 * A rejected or throwing call is not caught: the key goes back and the failure propagates.
 * A served submission re-arms the run read instead of splicing the reply in.
 */
export function useHumanFormSubmit(
  submitForm: WorkflowHumanFormSubmitCall,
  phase: HumanFormPhase,
): WorkflowHumanFormDispatch {
  const latch = useGenerationLatch();
  // Seeded once per attempt: a refresh that moves `phase.formRevision` under a live form must
  // not change the revision the answer is stamped with, or the daemon's stale check is defeated.
  const { value: attempt, publish } = useSubjectScopedState<WorkflowHumanFormAttempt>(
    submitForm,
    phase.phaseRunId,
    () => ({ composedAgainstRevision: phase.formRevision, outcome: IDLE }),
  );
  // The run pane's re-arm; `undefined` where no run pane is above this form.
  const recordServedRunAct = useRecordServedRunAct();
  // A function over the held value, so the captured revision survives every settlement and a
  // write from an old closure cannot restore a stale copy of it.
  const publishOutcome = (outcome: WorkflowHumanFormOutcome): void => {
    publish((held) => ({ ...held, outcome }));
  };

  // Neither a rejection nor a synchronous throw is caught: the key goes back either way, so
  // a later press is not refused as a duplicate of a call that ended.
  const putSubmission = async (
    claim: GenerationClaim,
    fields: WorkflowHumanFormFields,
  ): Promise<void> => {
    try {
      const reply = await submitForm({
        workflowRunId: phase.workflowRunId,
        phaseId: phase.phaseId,
        fields,
        // The captured revision, never `phase.formRevision`, which a run read may have moved.
        // The daemon decides whether it is still current; a stale one is refused, not re-stamped.
        expectedRevision: attempt.composedAgainstRevision,
      });
      // The holder's publish carries its own addressing and `settle` checks the refresh is still
      // live, so an answer arriving after a retarget or an unmount settles nothing.
      claim.settle(() => {
        publishOutcome(submittedOutcome(reply));
        // Inside the same guard: a retired refresh re-arms no read.
        recordServedRunAct?.();
      });
    } finally {
      // Even when `publish` threw: a key held for the subject's life would refuse every press.
      claim.release();
    }
  };

  return {
    outcome: attempt.outcome,
    submit: (answer) => {
      const fields = submittableFields(answer);
      if (fields === undefined) {
        publishOutcome({ kind: "refused", refusal: answerNotComposedRefusal() });
        return;
      }
      // `claim`, never `supersedeAndClaim`: the first press is already outstanding.
      const claim = latch.claim(submitForm, phase.phaseRunId);
      if (claim === undefined) {
        publishOutcome({ kind: "refused", refusal: submitAlreadyInFlightRefusal() });
        return;
      }
      publishOutcome({ kind: "submitting" });
      void putSubmission(claim, fields);
    },
  };
}

/**
 * What one served reply means for the form that asked.
 *
 * Names the three members instead of spreading the reply, which also echoes the request.
 */
function submittedOutcome(
  reply: Awaited<ReturnType<WorkflowHumanFormSubmitCall>>,
): WorkflowHumanFormOutcome {
  return {
    kind: "submitted",
    phaseRunId: reply.phaseRunId,
    outputCount: reply.outputCount,
    submittedAt: reply.submittedAt,
  };
}

/** The refusal an answer that is not a set of named values earns. */
function answerNotComposedRefusal(): Refusal {
  const code: WorkflowHumanFormRefusalCode = "answer-not-composed";
  return refuse(
    WORKFLOW_HUMAN_FORM_ORIGIN,
    code,
    "This phase is answered with a set of named values, and what is typed is not one yet.",
  );
}

/** The refusal a second press earns while the first answer is still outstanding. */
function submitAlreadyInFlightRefusal(): Refusal {
  const code: WorkflowHumanFormRefusalCode = "submit-already-in-flight";
  return refuse(
    WORKFLOW_HUMAN_FORM_ORIGIN,
    code,
    "This answer is already with the background service. Wait for it to come back before sending another.",
  );
}
