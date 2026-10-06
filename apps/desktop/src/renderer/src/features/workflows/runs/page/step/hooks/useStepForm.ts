import { useCallback, useEffect, useRef, useState } from "react";

import type {
  WorkflowHumanFormPathAnswer,
  WorkflowHumanFormReadResponse,
} from "@ai-sidekicks/contracts/workflow/run/step/methods";
import type { WorkflowStepKey } from "@ai-sidekicks/contracts/workflow/run/step/record";

import { useLatestRef } from "#renderer/hooks/useLatestRef.js";
import { useSubjectRead } from "#renderer/hooks/useSubjectRead.js";
import type { ScheduledHandle } from "#renderer/lib/clock.js";
import type { Refusal } from "#renderer/lib/refusal/contract.js";
import { callDaemon } from "#renderer/services/daemon/reply.js";
import { useClock } from "#renderer/services/platform/hooks/useClock.js";
import type { PlatformBridge } from "#renderer/services/platform/bridge.js";
import {
  useWorkflowCall,
  type WorkflowCallState,
} from "#renderer/features/workflows/hooks/useWorkflowCall.js";
import {
  checkParamAnswers,
  draftParamAnswers,
  seedParamAnswers,
  type ParamAnswers,
  type ParamIssues,
} from "#renderer/features/workflows/param-form/answers.js";
import { resolutionReceipt } from "../receipts.js";

/** Where the step's form read stands. */
export type StepFormRead =
  | { readonly kind: "reading" }
  | { readonly kind: "read"; readonly form: WorkflowHumanFormReadResponse }
  | { readonly kind: "failed"; readonly refusal: Refusal };

/** Everything a step's form panel draws, and the acts it takes. */
export interface StepFormHold {
  readonly read: StepFormRead;
  readonly answers: ParamAnswers;
  readonly issues: ParamIssues;
  readonly changeAnswers: (next: ParamAnswers) => void;
  readonly submit: () => void;
  readonly submitState: WorkflowCallState<unknown>;
  /** A draft the daemon refused to save, said in place; typing goes on. */
  readonly draftRefusal: Refusal | undefined;
  readonly readAgain: () => void;
}

/** Answers a person typed, and the read of the form they were typed against. */
interface TypedAnswers {
  readonly form: WorkflowHumanFormReadResponse;
  readonly answers: ParamAnswers;
}

/** How long typing rests before what was typed is saved to the daemon, in milliseconds. */
export const DRAFT_SAVE_REST_MS = 600;

/**
 * A step waiting on a form: the daemon's form read, the answers as they are typed, each saved to
 * the daemon once typing rests so a half-filled form survives a reload and nothing is kept in the
 * window, and the submit that replaces the form with its receipt. Saves go one at a time, each on
 * the revision the one before it returned; a save still resting when the form goes is sent then;
 * a secret's answer is never saved. A picked folder or file is sent in `paths` at its dotted place,
 * never in `fields`. An answer the form refuses is said in place and sends nothing.
 */
export function useStepForm(
  bridge: PlatformBridge,
  stepKey: WorkflowStepKey,
  onAnswered: (receipt: string) => void,
): StepFormHold {
  const clock = useClock();
  const subject = `${stepKey.workflowRunId}/${stepKey.nodeId}/${String(stepKey.executionIndex)}`;
  const [readRevision, setReadRevision] = useState(0);
  const { value: read } = useSubjectRead<StepFormRead, StepFormRead>(
    bridge,
    subject,
    async (_subject, signal) => {
      const reply = await callDaemon(bridge, "workflow.humanFormRead", stepKey, { signal });
      return reply.status === "served"
        ? { kind: "read", form: reply.value }
        : { kind: "failed", refusal: reply.refusal };
    },
    { unsettled: () => ({ kind: "reading" }), settled: (value) => value },
    readRevision,
  );
  // The answers typed against one read of the form. Until the first change they are the read's
  // own seed: the saved draft where there is one, else each field's default.
  const [typed, setTyped] = useState<TypedAnswers | undefined>(undefined);
  const [issues, setIssues] = useState<ParamIssues>({});
  const [draftRefusal, setDraftRefusal] = useState<Refusal | undefined>(undefined);
  const draftRevision = useRef<number | undefined>(undefined);
  // The save resting until typing stops, and the draft it will send.
  const pendingSave = useRef<{ handle: ScheduledHandle; draft: ParamAnswers } | undefined>(
    undefined,
  );
  // Whether a save is in flight, and the newest draft waiting behind it.
  const isSaving = useRef(false);
  const queuedDraft = useRef<ParamAnswers | undefined>(undefined);
  const form = read.kind === "read" ? read.form : undefined;
  const answers: ParamAnswers =
    form === undefined
      ? {}
      : typed?.form === form
        ? typed.answers
        : seedParamAnswers(form.fields, form.draft?.formState);

  const saveDraft = useCallback(
    function sendDraft(draft: ParamAnswers): void {
      if (isSaving.current) {
        queuedDraft.current = draft;
        return;
      }
      isSaving.current = true;
      const expectedRevision = draftRevision.current;
      void callDaemon(bridge, "workflow.humanFormDraftSave", {
        ...stepKey,
        formState: { ...draft },
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      }).then((reply) => {
        isSaving.current = false;
        if (reply.status === "refused") {
          setDraftRefusal(reply.refusal);
        } else {
          draftRevision.current = reply.value.revision;
          setDraftRefusal(undefined);
        }
        const next = queuedDraft.current;
        queuedDraft.current = undefined;
        if (next !== undefined) {
          sendDraft(next);
        }
      });
    },
    [bridge, stepKey],
  );

  // A save still resting when the form goes is sent at once, so the last typing is not lost.
  const latestSaveDraft = useLatestRef(saveDraft);
  useEffect(
    () => () => {
      const resting = pendingSave.current;
      if (resting !== undefined) {
        pendingSave.current = undefined;
        clock.cancel(resting.handle);
        latestSaveDraft.current(resting.draft);
      }
    },
    [clock, latestSaveDraft],
  );

  const changeAnswers = useCallback(
    (next: ParamAnswers) => {
      if (form === undefined) {
        return;
      }
      if (typed?.form !== form) {
        draftRevision.current = form.draft?.revision;
      }
      setTyped({ form, answers: next });
      if (pendingSave.current !== undefined) {
        clock.cancel(pendingSave.current.handle);
      }
      const draft = draftParamAnswers(form.fields, next);
      pendingSave.current = {
        draft,
        handle: clock.scheduleTimeout(() => {
          pendingSave.current = undefined;
          saveDraft(draft);
        }, DRAFT_SAVE_REST_MS),
      };
    },
    [clock, form, saveDraft, typed],
  );

  const submission = useWorkflowCall(
    (request: {
      readonly fields: Record<string, unknown>;
      readonly paths: WorkflowHumanFormPathAnswer[];
      readonly expectedRevision: number;
    }) => callDaemon(bridge, "workflow.humanFormSubmit", { ...stepKey, ...request }),
    (submitted) => {
      onAnswered(resolutionReceipt({ kind: "answered", at: submitted.submittedAt }, clock.now()));
    },
  );

  const submit = useCallback(() => {
    if (form === undefined) {
      return;
    }
    const check = checkParamAnswers(form.fields, answers);
    if (check.kind === "invalid") {
      setIssues(check.issues);
      return;
    }
    setIssues({});
    // The submit carries every answer, so no draft goes after it.
    if (pendingSave.current !== undefined) {
      clock.cancel(pendingSave.current.handle);
      pendingSave.current = undefined;
    }
    queuedDraft.current = undefined;
    submission.take({
      fields: check.values,
      paths: check.paths,
      expectedRevision: form.formRevision,
    });
  }, [answers, clock, form, submission]);

  const readAgain = useCallback(() => {
    setReadRevision((revision) => revision + 1);
  }, []);

  return {
    read,
    answers,
    issues,
    changeAnswers,
    submit,
    submitState: submission.state,
    draftRefusal,
    readAgain,
  };
}
