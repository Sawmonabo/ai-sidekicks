// Answering a phase parked on a person: what a press puts, and what the answer settles
// to. The call is the caller's, and a rejected call is not caught here.
//
// THE REVISION IS CAPTURED WHEN THE ATTEMPT OPENS, AND NEVER RE-READ AT PRESS TIME.
// Re-reading it is the whole failure the optimistic-concurrency token exists to catch: a
// submission the daemon has already accepted advances the attempt's revision, and a
// second press that fetched the new one would overwrite somebody's accepted answer
// while reporting success.
//
// AND THE RESOLVED PHASE'S OWN MEMBER IS NOT ENOUGH TO GET THAT RIGHT, which is why it is
// held rather than read. The pane re-reads the run whenever anything moves it, and a
// refresh that finds the SAME waiting attempt at a newer revision hands this hook a new
// `formRevision` under a form somebody is still typing into — the attempt is keyed on
// `phaseRunId`, so the draft survives that refresh exactly as it should. Reading the
// member at the press would then send the answer composed against revision 0 stamped
// with revision 1, and the daemon's comparison — the one thing that can tell it the
// answer is stale — would find it current and accept it over whatever moved the run.
// So the value the form was COMPOSED against is captured beside the outcome, in the same
// subject-scoped holder and under the same key, and a new `phaseRunId` captures afresh.
//
// NOTHING HERE ADJUDICATES. Whether this user may answer, whether the phase is
// still waiting, whether the revision is stale — every one of those is the daemon's.
// A form that predicted any of them would be a second authority on a question it
// cannot see the inputs to.
//
// SINGLE FLIGHT IS THE LATCH'S, on `run-control-dispatch.ts`'s own reasoning: a
// `submitting` value read inside a press handler is the one from the render that
// produced the handler, so two presses in one frame both find the form idle and both
// send. Two submissions of one answer is exactly what the revision token refuses at
// the far end, and refusing the second here — out loud, on the control — is the
// difference between a form that explains itself and one that reports a stale-revision
// failure for an answer the operator only gave once. The claim is `claim` and never
// `supersedeAndClaim`: the first press is already outstanding and cannot be recalled.
//
// THE SUBJECT IS THE PHASE RUN AND NOT THE RUN. One run branches into several waits and
// the pane opens one at a time, so a settlement belongs to the attempt it was made
// against — a run-keyed holder would carry one branch's refusal onto the next branch's
// form. The call joins it, so replacing the call retires one made through the previous
// one.
//
// AND A SERVED SUBMISSION RE-ARMS THE RUN READ, which this outcome cannot do for itself.
// The outcome above is one attempt's settlement; the pane's snapshot is the run, and a
// daemon that recorded the answer has moved the phase this form is composed against. So
// a served submission records the act through `served-run-act.ts` — the SAME round a served
// cancel or resume advances, held by `run-control-dispatch.ts` — and the pane asks the
// daemon once more. Nothing the reply reported is spliced into that snapshot: the run is
// read again rather than believed twice, so the parked phase either stands or goes on
// the daemon's own answer. Without it a submission the daemon accepted left the pane
// rendering the old park and its form indefinitely, saying in the same breath that the
// answer had been recorded.

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
 * One attempt at one phase's form: what it was composed against, and where it got to.
 *
 * ONE HELD VALUE AND NOT TWO, because both facts are scoped to the same attempt and a
 * second holder keyed the same way would be a second answer to when an attempt begins.
 * The revision is seeded once, when the holder is addressed at a `phaseRunId` it was not
 * addressed at before, and every later write carries it through untouched — which is what
 * makes "the revision this form was composed against" a fact about the ATTEMPT rather
 * than about whichever run read landed most recently.
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
 * A rejected or throwing call is not caught here: the key goes back and the failure
 * propagates.
 *
 * The resolved phase is taken whole rather than as four parameters, because every member
 * of the request is read off it and the four have to be ONE answer: composed from
 * separately passed values, a pane retargeted mid-read could pair a new run's id with the
 * phase and the revision still on screen from the run before it.
 *
 * It takes the PANE's resolution and not the body's mount, which is the direction the
 * dependency has to run: the mount is this hook's own `submit` spread over that phase,
 * so a signature naming the mount would be a hook asking for the value it produces.
 */
export function useHumanFormSubmit(
  submitForm: WorkflowHumanFormSubmitCall,
  phase: HumanFormPhase,
): WorkflowHumanFormDispatch {
  const latch = useGenerationLatch();
  // Seeded on the render that first addresses this attempt, which is where the revision
  // it is composed against is still the one on screen. A refresh that moves
  // `phase.formRevision` under a live attempt re-addresses nothing, so this seed does
  // not run again and the captured number stands until the attempt itself changes.
  const { value: attempt, publish } = useSubjectScopedState<WorkflowHumanFormAttempt>(
    submitForm,
    phase.phaseRunId,
    () => ({ composedAgainstRevision: phase.formRevision, outcome: IDLE }),
  );
  // The run pane's own re-arm, reached through the seat rather than through the mount:
  // `undefined` where this form is rendered with no run pane above it, which is a form
  // with no run read behind it to put again.
  const recordServedRunAct = useRecordServedRunAct();
  // Written as a function over the held value rather than as one, so the captured
  // revision travels through every settlement without this caller restating it — and so
  // a write from a closure that was composed several renders ago cannot carry a stale
  // copy of it back into the holder.
  const publishOutcome = (outcome: WorkflowHumanFormOutcome): void => {
    publish((held) => ({ ...held, outcome }));
  };

  // Puts the call and publishes what comes back. Neither a rejection nor a synchronous throw
  // is caught: the key goes back either way, so a later press is not refused as a duplicate
  // of a call that ended.
  const putSubmission = async (
    claim: GenerationClaim,
    fields: WorkflowHumanFormFields,
  ): Promise<void> => {
    try {
      const reply = await submitForm({
        workflowRunId: phase.workflowRunId,
        phaseId: phase.phaseId,
        fields,
        // The CAPTURED revision, including the `0` a fresh attempt reads, and never
        // `phase.formRevision` — which a run read may have moved under the form since.
        // The daemon decides whether it is still current; this surface never compares
        // it, and a form composed against a revision the run has left behind is
        // supposed to be refused rather than quietly re-stamped as current.
        expectedRevision: attempt.composedAgainstRevision,
      });
      // Published through the holder's own handle, which carries the addressing it
      // was captured under: an answer arriving after the pane moved to another
      // wait writes nowhere rather than settling one phase's submission under
      // another's form. The claim's own `settle` is the other guard — it asks
      // whether this round is still the live one, which the unmount path retires.
      claim.settle(() => {
        publishOutcome(submittedOutcome(reply));
        // INSIDE THE SAME GUARD, and after the outcome rather than beside it. A
        // settlement whose round has been retired settles nothing and must re-arm
        // nothing either — a read put behind an unmounted pane is a call nobody is
        // waiting for.
        recordServedRunAct?.();
      });
    } finally {
      // Whatever happened, a `publish` that threw included: a key held for the life of
      // the subject would refuse every later press.
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
      const claim = latch.takeShell(submitForm, phase.phaseRunId);
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
 * The three members are named rather than spread, so a member this outcome does not
 * declare cannot arrive by accident — the reply also carries the `phaseId` the caller
 * supplied, and echoing a request back as though it were news is how a settlement
 * comes to look like a reading.
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
