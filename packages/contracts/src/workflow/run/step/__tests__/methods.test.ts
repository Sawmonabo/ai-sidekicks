// One step is answered and read from the run's step panel. These tests hold what that
// panel depends on: an approval answered in the approvals' own words, for a step or a
// chain's question, and a form addressed by the step it waits on.
import { describe, expect, it } from "vitest";

import {
  WorkflowGateResolveRequestSchema,
  WorkflowGateResolveResponseSchema,
  WorkflowHumanFormReadResponseSchema,
  WorkflowHumanFormSubmitRequestSchema,
  WorkflowStepReadRequestSchema,
} from "../methods.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const STEP = { workflowRunId: RUN_ID, nodeId: "review-form", executionIndex: 4 };

describe("workflow.gateResolve", () => {
  it("accepts an approval step's answer and a chain question's answer, which names no node", () => {
    const approve = { workflowRunId: RUN_ID, nodeId: "approve", decision: "approved" };
    const stopThemAll = { workflowRunId: RUN_ID, decision: "rejected" };
    expect(WorkflowGateResolveRequestSchema.safeParse(approve).success).toBe(true);
    expect(WorkflowGateResolveRequestSchema.safeParse(stopThemAll).success).toBe(true);
  });

  it("refuses a gate state in place of the approvals' words", () => {
    const passed = { workflowRunId: RUN_ID, nodeId: "approve", decision: "passed" };
    expect(WorkflowGateResolveRequestSchema.safeParse(passed).success).toBe(false);
  });
});

describe("workflow.gateResolve's answer", () => {
  it("answers with the approval record's entry: its id and when it was decided", () => {
    const answer = { gateResolutionId: "gr-1", decidedAt: "2026-09-29T20:00:00.000-04:00" };
    expect(WorkflowGateResolveResponseSchema.safeParse(answer).success).toBe(true);
    expect(WorkflowGateResolveResponseSchema.safeParse({ gateResolutionId: "gr-1" }).success).toBe(
      false,
    );
  });
});

describe("workflow.humanFormRead", () => {
  const form = {
    prompt: "Summarize what changed",
    fields: [{ id: "summary", label: "Summary", type: "text", required: true }],
    formRevision: 0,
    draft: { formState: { summary: "Half" }, revision: 2, savedAt: "2026-09-29T14:10:00Z" },
  };

  it("accepts the prompt, its fields and the saved draft", () => {
    expect(WorkflowHumanFormReadResponseSchema.safeParse(form).success).toBe(true);
  });

  it("refuses a form that carries no fields", () => {
    const { fields: _dropped, ...withoutFields } = form;
    expect(WorkflowHumanFormReadResponseSchema.safeParse(withoutFields).success).toBe(false);
  });

  it("refuses a field of a type the inspector's form cannot draw", () => {
    const artifactField = { ...form, fields: [{ id: "file", label: "File", type: "artifact" }] };
    expect(WorkflowHumanFormReadResponseSchema.safeParse(artifactField).success).toBe(false);
  });
});

describe("workflow.humanFormSubmit", () => {
  it("accepts a first submit on the waiting step", () => {
    const submit = { ...STEP, fields: { summary: "Looks right" }, expectedRevision: 0 };
    expect(WorkflowHumanFormSubmitRequestSchema.safeParse(submit).success).toBe(true);
  });

  it("takes each path field's answer beside the fields, once per field", () => {
    const answer = { field: "target.0.folder", path: "/Users/dev/code/ai-sidekicks" };
    const submit = { ...STEP, fields: { summary: "Ship it" }, expectedRevision: 0 };
    expect(
      WorkflowHumanFormSubmitRequestSchema.safeParse({ ...submit, paths: [answer] }).success,
    ).toBe(true);
    expect(
      WorkflowHumanFormSubmitRequestSchema.safeParse({ ...submit, paths: [answer, answer] })
        .success,
    ).toBe(false);
  });

  it("refuses a submit that does not say which execution of the node it answers", () => {
    const { executionIndex: _dropped, ...withoutExecution } = STEP;
    const submit = { ...withoutExecution, fields: {}, expectedRevision: 0 };
    expect(WorkflowHumanFormSubmitRequestSchema.safeParse(submit).success).toBe(false);
  });
});

describe("workflow.stepRead", () => {
  it("refuses a payload other than the input, output or log", () => {
    expect(WorkflowStepReadRequestSchema.safeParse({ ...STEP, which: "error" }).success).toBe(
      false,
    );
  });
});
