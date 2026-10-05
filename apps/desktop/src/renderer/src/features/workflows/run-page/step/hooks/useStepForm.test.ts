// A step's form saves what was typed to the daemon, so a half-filled form survives a reload: saves
// go one at a time, each on the revision the one before it returned; a save still resting when the
// form goes is sent then; and a secret's answer never leaves the window.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  WorkflowHumanFormReadResponse,
  WorkflowStepKey,
} from "@ai-sidekicks/contracts/workflow/run/step";

import { bridgeWrapper } from "@test/helpers/app/frame-fixtures.js";
import { bridgeAnswering } from "@test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import { WORKFLOW_RUN_IDS, WORKFLOW_RUN_RECORDS } from "@fixtures/data/workflow/runs.js";
import { useStepForm, type StepFormHold } from "./useStepForm.js";

/** How long the fixture daemon takes to read a form, and how long typing rests before a save. */
const FORM_READ_DELAY_MS = 120;
const DRAFT_SAVE_REST_MS = 600;

function waitingFormStep(): WorkflowStepKey {
  const run = WORKFLOW_RUN_RECORDS.find(
    (record) => record.read.workflowRunId === WORKFLOW_RUN_IDS.waitingForm,
  );
  const step = run?.read.steps.find((candidate) => candidate.status === "waiting");
  if (run === undefined || step === undefined) {
    throw new Error("the fixture daemon holds no step waiting on a form");
  }
  return {
    workflowRunId: run.read.workflowRunId,
    nodeId: step.nodeId,
    executionIndex: step.executionIndex,
  };
}

describe("a step's form drafts", () => {
  it("chains its saves, sends a resting one as the form goes, keeps no secret, and survives a reload", async () => {
    let releaseFirstSave: () => void = () => undefined;
    const firstSaveHeld = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    let draftSaves = 0;
    const { bridge, calls, engine } = bridgeAnswering(async (call, passThrough) => {
      if (call.method === "workflow.humanFormDraftSave") {
        draftSaves += 1;
        if (draftSaves === 1) {
          await firstSaveHeld;
        }
      }
      if (call.method === "workflow.humanFormRead") {
        // The fixture form, with a secret field added to it.
        const form = (await passThrough()) as WorkflowHumanFormReadResponse;
        return {
          ...form,
          fields: [...form.fields, { id: "token", label: "Token", type: "secret" }],
        };
      }
      return passThrough();
    });
    const stepKey = waitingFormStep();
    const settle = async (deltaMs: number): Promise<void> => {
      await act(async () => {
        engine.advance(deltaMs);
        await crossMacrotaskBoundary();
      });
    };
    const mountForm = (): { readonly current: StepFormHold; readonly unmount: () => void } => {
      const { result, unmount } = renderHook(() => useStepForm(bridge, stepKey, () => undefined), {
        wrapper: bridgeWrapper(bridge, engine.clock),
      });
      return {
        get current() {
          return result.current;
        },
        unmount,
      };
    };
    const type = async (
      form: { readonly current: StepFormHold },
      version: string,
    ): Promise<void> => {
      await act(async () => {
        form.current.changeAnswers({ ...form.current.answers, version, token: "hunter2" });
        await crossMacrotaskBoundary();
      });
    };
    const draftSaveCalls = () =>
      calls.filter((call) => call.method === "workflow.humanFormDraftSave");

    const form = mountForm();
    await settle(FORM_READ_DELAY_MS);
    expect(form.current.read.kind).toBe("read");

    await type(form, "2.0");
    await settle(DRAFT_SAVE_REST_MS);
    expect(draftSaveCalls()).toHaveLength(1);

    // A second save waits behind the first, then goes on the revision the first returned.
    await type(form, "2.1");
    await settle(DRAFT_SAVE_REST_MS);
    expect(draftSaveCalls()).toHaveLength(1);
    await act(async () => {
      releaseFirstSave();
      await crossMacrotaskBoundary();
    });
    await settle(0);
    expect(draftSaveCalls().map((call) => call.params)).toStrictEqual([
      { ...stepKey, formState: expect.objectContaining({ version: "2.0" }) },
      { ...stepKey, formState: expect.objectContaining({ version: "2.1" }), expectedRevision: 1 },
    ]);

    // Typing that has not rested when the form goes is saved then.
    await settle(0);
    await type(form, "2.2");
    form.unmount();
    await settle(0);
    expect(draftSaveCalls()).toHaveLength(3);
    for (const call of draftSaveCalls()) {
      expect(call.params).toHaveProperty("formState");
      expect((call.params as { formState: object }).formState).not.toHaveProperty("token");
    }

    const reloaded = mountForm();
    await settle(FORM_READ_DELAY_MS);
    expect(reloaded.current.answers).toMatchObject({ version: "2.2" });
    expect(reloaded.current.answers).not.toHaveProperty("token", "hunter2");
    reloaded.unmount();
  });
});
