// A step's form saves what was typed to the daemon, so a half-filled form survives a reload: saves
// go one at a time, each on the revision the one before it returned; a save still resting when the
// form goes is sent then; and a secret's answer never leaves the window. A picked folder is sent
// apart from the other answers, at its dotted place, where main swaps its token for the path.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  WorkflowHumanFormReadResponse,
  WorkflowStepKey,
} from "@ai-sidekicks/contracts/workflow/run/step";

import type { FilePathRef } from "#shared/preload-api.js";
import { bridgeWrapper } from "#test/helpers/app/frame-fixtures.js";
import { bridgeAnswering } from "#test/helpers/fixture/bridge.js";
import { crossMacrotaskBoundary } from "#test/helpers/macrotask-boundary.js";
import { WORKFLOW_READ_LATENCY_MS } from "#fixtures/data/workflow/replies.js";
import { WORKFLOW_RUN_IDS, WORKFLOW_RUN_RECORDS } from "#fixtures/data/workflow/run/records.js";
import { DRAFT_SAVE_REST_MS, useStepForm, type StepFormHold } from "./useStepForm.js";

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
    await settle(WORKFLOW_READ_LATENCY_MS);
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
    await settle(WORKFLOW_READ_LATENCY_MS);
    expect(reloaded.current.answers).toMatchObject({ version: "2.2" });
    expect(reloaded.current.answers).not.toHaveProperty("token", "hunter2");
    reloaded.unmount();
  });
});

describe("a step's form submit", () => {
  it("sends a picked folder in paths at its dotted place, never in fields", async () => {
    const { bridge, calls, engine } = bridgeAnswering(async (call, passThrough) => {
      if (call.method === "workflow.humanFormRead") {
        // The fixture form, asking for a repeating target with a folder and a note in each.
        const form = (await passThrough()) as WorkflowHumanFormReadResponse;
        return {
          ...form,
          fields: [
            {
              id: "target",
              label: "Target",
              type: "collection",
              multiple: true,
              fields: [
                { id: "folder", label: "Folder", type: "path", required: true },
                { id: "note", label: "Note", type: "string" },
              ],
            },
          ],
        };
      }
      return passThrough();
    });
    const { result } = renderHook(() => useStepForm(bridge, waitingFormStep(), () => undefined), {
      wrapper: bridgeWrapper(bridge, engine.clock),
    });
    await act(async () => {
      engine.advance(WORKFLOW_READ_LATENCY_MS);
      await crossMacrotaskBoundary();
    });
    expect(result.current.read.kind).toBe("read");

    // What the folder chooser hands back: main's token for the picked folder.
    const pickedFolder = "file-path-ref-1" as FilePathRef;
    await act(async () => {
      result.current.changeAnswers({ target: [{ folder: pickedFolder, note: "the app" }] });
      await crossMacrotaskBoundary();
    });
    await act(async () => {
      result.current.submit();
      await crossMacrotaskBoundary();
    });

    const submits = calls.filter((call) => call.method === "workflow.humanFormSubmit");
    expect(submits).toHaveLength(1);
    expect(submits[0]?.params).toMatchObject({
      fields: { target: [{ note: "the app" }] },
      paths: [{ field: "target.0.folder", path: pickedFolder }],
    });
    expect(JSON.stringify((submits[0]?.params as { fields: unknown }).fields)).not.toContain(
      pickedFolder,
    );
  });
});
