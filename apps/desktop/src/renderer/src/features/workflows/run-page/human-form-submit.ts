// What answering a phase parked on a person puts, and what the answer settles to.

import type { Refusal } from "@renderer/lib/refusal.js";
import { isWireRecord } from "@renderer/lib/wire-record.js";

/** The subsystem name every refusal raised in this file carries. */
export const WORKFLOW_HUMAN_FORM_ORIGIN = "workflow-human-form";

/**
 * The refusals the human-form submit raises on its own, and no others.
 *
 * Both are cases with no daemon in the loop: an answer that is not an object, and a second
 * press while one is outstanding. Any other failure is the call's own and is not caught.
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
 * Where this form's last press got to: idle, submitting, submitted, or refused.
 *
 * There is no optimistic arm: what a person sees change is what the daemon answered.
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
 * The raw editor can compose any JSON, including numbers, strings and arrays, which the
 * request cannot carry; those are refused with a sentence instead of cast.
 */
export function submittableFields(answer: unknown): WorkflowHumanFormFields | undefined {
  return isWireRecord(answer) ? answer : undefined;
}
