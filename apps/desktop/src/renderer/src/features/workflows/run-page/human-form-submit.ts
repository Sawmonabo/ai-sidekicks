// What answering a phase parked on a person puts, and what the answer settles to.

import type { Refusal } from "@renderer/lib/refusal.js";

/** The subsystem name every refusal raised in this file carries. */
export const WORKFLOW_HUMAN_FORM_ORIGIN = "workflow-human-form";

/**
 * The refusals the human-form submit raises on its own, and no others.
 *
 * Both are cases where there is no daemon in the loop at all — an answer that is not
 * an object cannot be composed into the request's `fields` at all, and a second press
 * is visibly a duplicate of one already outstanding. Any other failure is the call's own
 * and is not caught here.
 */
export type WorkflowHumanFormRefusalCode = "answer-not-composed" | "submit-already-in-flight";

/** What a submitted answer carries: the object the phase's schema asked for. */
export type WorkflowHumanFormFields = Readonly<Record<string, unknown>>;

/**
 * The call that submits one phase's form.
 *
 * Pass a stable function: a new identity starts the attempt over, dropping its outcome and
 * capturing the revision the form is composed against afresh.
 */
export type WorkflowHumanFormSubmitCall = (request: {
  readonly workflowRunId: string;
  readonly phaseId: string;
  readonly fields: WorkflowHumanFormFields;
  readonly expectedRevision: number;
}) => Promise<{
  readonly phaseId: string;
  readonly phaseRunId: string;
  readonly outputCount: number;
  readonly submittedAt: string;
}>;

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
  | { readonly kind: "refused"; readonly refusal: Refusal };

/** The form's act, and where the last one got to. */
export interface WorkflowHumanFormDispatch {
  readonly outcome: WorkflowHumanFormOutcome;
  /** Send this answer, whatever input mode composed it. */
  readonly submit: (answer: unknown) => void;
}

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
