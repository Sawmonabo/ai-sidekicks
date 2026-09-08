// Answering a phase parked on a person: what a press puts on the growth port, and
// what the answer settles to.
//
// THE REVISION IS CARRIED, NEVER RE-READ. The mount hands over the `formRevision` the
// form was composed against and this hook sends exactly that number. Re-reading it at
// press time is the whole failure the optimistic-concurrency token exists to catch: a
// submission the daemon has already accepted advances the attempt's revision, and a
// second press that fetched the new one would overwrite somebody's accepted answer
// while reporting success. So the value travels with the form and the daemon decides
// whether it is still current.
//
// NOTHING HERE ADJUDICATES. Whether this participant may answer, whether the phase is
// still waiting, whether the revision is stale — every one of those is the daemon's,
// and each arrives as a typed refusal rendered verbatim beside the control. A form
// that predicted any of them would be a second authority on a question it cannot see
// the inputs to.
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
// form. The port joins it for the fixture's own reason: a scenario switch replaces the
// bridge and keeps every id, and a call made through the previous bridge is retired by
// that replacement.

import {
  settleGrowthRead,
  type GrowthPort,
  type GrowthUnavailable,
  type SettledReadRefusal,
} from "../../../bridge/index.js";
import { refuse, type ConsoleRefusal } from "../../../core/index.js";
import { useGenerationLatch, useSubjectScopedState } from "../../../store/index.js";
import type { HumanFormMount } from "./slots/human-form-mount.js";

/** The subsystem name every refusal raised in this file carries. */
export const WORKFLOW_HUMAN_FORM_ORIGIN = "workflow-human-form";

/**
 * The refusals this surface raises on its own, and no others.
 *
 * Both are cases where there is no daemon in the loop at all — an answer that is not
 * an object cannot be composed into the request's `fields` at all, and a second press
 * is visibly a duplicate of one already outstanding. Every other refusal a submit can
 * meet is the daemon's or the port's and is rendered verbatim.
 */
export type WorkflowHumanFormRefusalCode = "answer-not-composed" | "submit-already-in-flight";

/** What a submitted answer carries: the object the phase's schema asked for. */
export type WorkflowHumanFormFields = Readonly<Record<string, unknown>>;

/**
 * Where this form's last press got to.
 *
 * FOUR ARMS BECAUSE FOUR THINGS ARE TRUE AT DIFFERENT MOMENTS: nobody has answered, an
 * answer is out, the daemon took it, or it was refused. There is deliberately no
 * optimistic arm — what a person sees change is what the daemon answered, and a form
 * that cleared itself on the press would be reporting an acceptance nobody gave.
 */
export type WorkflowHumanFormOutcome =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | {
      readonly kind: "submitted";
      /** The attempt the daemon recorded the answer against, wire-verbatim. */
      readonly phaseRunId: string;
      /** How many outputs the submission produced, as the reply reported them. */
      readonly outputCount: number;
      /** When the daemon recorded it, wire-verbatim and never re-formatted here. */
      readonly submittedAt: string;
    }
  | { readonly kind: "refused"; readonly refusal: ConsoleRefusal };

/** The form's act, and where the last one got to. */
export interface WorkflowHumanFormDispatch {
  readonly outcome: WorkflowHumanFormOutcome;
  /** Send this answer, whatever input mode composed it. */
  readonly submit: (answer: unknown) => void;
}

/** Nobody has answered this phase yet, which is where every form opens. */
const IDLE: WorkflowHumanFormOutcome = { kind: "idle" };

/**
 * How a submit call can end.
 *
 * Three arms and not two, on the run controls' own reading: the port's refusal for a
 * wire this build cannot serve, the read seam's reading of a REJECTION — a scripted
 * daemon refusal is thrown verbatim and the live seam will throw the same shape — and
 * the served value.
 */
type SubmitSettlement =
  | Awaited<ReturnType<GrowthPort["workflowHumanFormSubmit"]>>
  | GrowthUnavailable
  | SettledReadRefusal;

/**
 * The answer as the request's `fields` member, or nothing where it is not one.
 *
 * The raw editor composes whatever JSON a person typed, and JSON is legally a number,
 * a string, or an array — none of which the request can carry. Read here rather than
 * asserted, so an answer the wire cannot take is refused with a sentence instead of
 * being cast into a shape the daemon would reject after the round trip.
 */
export function submittableFields(answer: unknown): WorkflowHumanFormFields | undefined {
  return typeof answer === "object" && answer !== null && !Array.isArray(answer)
    ? (answer as WorkflowHumanFormFields)
    : undefined;
}

/**
 * What one settlement means for the form that asked.
 *
 * The three members the reply's own arm carries are named rather than spread, so a
 * member this outcome does not declare cannot arrive by accident — the reply also
 * carries the `phaseId` the caller supplied, and echoing a request back as though it
 * were news is how a settlement comes to look like a reading. A refusal is carried
 * VERBATIM: the port's unregistered-wire sentence names the wire and who owes it, and
 * a daemon's `workflow.*` code is its own adjudication.
 */
function settledOutcome(settlement: SubmitSettlement): WorkflowHumanFormOutcome {
  return settlement.status === "served"
    ? {
        kind: "submitted",
        phaseRunId: settlement.value.phaseRunId,
        outputCount: settlement.value.outputCount,
        submittedAt: settlement.value.submittedAt,
      }
    : { kind: "refused", refusal: settlement };
}

/** The refusal an answer that is not a set of named values earns. */
function answerNotComposedRefusal(): ConsoleRefusal {
  const code: WorkflowHumanFormRefusalCode = "answer-not-composed";
  return refuse(
    WORKFLOW_HUMAN_FORM_ORIGIN,
    code,
    "This phase is answered with a set of named values, and what is typed is not one yet.",
  );
}

/** The refusal a second press earns while the first answer is still outstanding. */
function submitAlreadyInFlightRefusal(): ConsoleRefusal {
  const code: WorkflowHumanFormRefusalCode = "submit-already-in-flight";
  return refuse(
    WORKFLOW_HUMAN_FORM_ORIGIN,
    code,
    "This answer is already with the daemon. Wait for it to come back before sending another.",
  );
}

/**
 * Offer one waiting phase's submit, dispatching it through the growth port.
 *
 * The mount is taken whole rather than as four parameters, because every member of the
 * request is read off it and the four have to be ONE answer: composed from separately
 * passed values, a pane retargeted mid-read could pair a new run's id with the phase
 * and the revision still on screen from the run before it.
 */
export function useHumanFormSubmit(
  growth: GrowthPort,
  mount: HumanFormMount,
): WorkflowHumanFormDispatch {
  const latch = useGenerationLatch();
  const { value: outcome, publish } = useSubjectScopedState<WorkflowHumanFormOutcome>(
    growth,
    mount.phaseRunId,
    () => IDLE,
  );

  return {
    outcome,
    submit: (answer) => {
      const fields = submittableFields(answer);
      if (fields === undefined) {
        publish({ kind: "refused", refusal: answerNotComposedRefusal() });
        return;
      }
      const claim = latch.claim(growth, mount.phaseRunId);
      if (claim === undefined) {
        publish({ kind: "refused", refusal: submitAlreadyInFlightRefusal() });
        return;
      }
      publish({ kind: "submitting" });
      void settleGrowthRead(
        growth.workflowHumanFormSubmit({
          workflowRunId: mount.workflowRunId,
          phaseId: mount.phaseId,
          fields,
          // Verbatim, including the `0` a fresh attempt reads. The daemon decides
          // whether it is still current; this surface never compares it.
          expectedRevision: mount.formRevision,
        }),
      )
        .then((settlement) => {
          // Published through the holder's own handle, which carries the addressing it
          // was captured under: an answer arriving after the pane moved to another
          // wait writes nowhere rather than settling one phase's submission under
          // another's form. The claim's own `settle` is the other guard — it asks
          // whether this round is still the live one, which the unmount path retires.
          claim.settle(() => {
            publish(settledOutcome(settlement));
          });
        })
        .finally(() => {
          // The key goes back whatever happened, a `publish` that threw included: a key
          // held for the life of the subject would refuse every later press.
          claim.release();
        });
    },
  };
}
