// One step is answered and read from the run's step panel. These tests hold what that
// panel depends on: an approval answered in the approvals' own words, for a step or a
// chain's question, and a form addressed by the step it waits on.
import { describe, expect, it } from "vitest";

import {
  WorkflowGateResolveRequestSchema,
  WorkflowGateResolveResponseSchema,
  WorkflowGateResolvedPayloadSchema,
  WorkflowHumanFormReadResponseSchema,
  WorkflowHumanFormSubmitRequestSchema,
  WorkflowStepReadRequestSchema,
} from "../workflow-run-step.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
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

  it("names the answering device and pinned version, and refuses a scope on the event", () => {
    const event = {
      sessionId: SESSION_ID,
      workflowRunId: RUN_ID,
      definitionId: "wfd-1",
      workflowVersionId: "wfv-3",
      outcome: "approved",
      gateResolutionId: "gr-1",
      deviceId: "desktop-1",
    };
    expect(WorkflowGateResolvedPayloadSchema.safeParse(event).success).toBe(true);
    const { deviceId: _deviceId, ...withoutDevice } = event;
    expect(WorkflowGateResolvedPayloadSchema.safeParse(withoutDevice).success).toBe(false);
    const { workflowVersionId: _workflowVersionId, ...withoutVersion } = event;
    expect(WorkflowGateResolvedPayloadSchema.safeParse(withoutVersion).success).toBe(false);
    expect(
      WorkflowGateResolvedPayloadSchema.safeParse({ ...event, scope: "workflow-phase" }).success,
    ).toBe(false);
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

  it("refuses a submit that does not say which execution of the node it answers", () => {
    const { executionIndex: _dropped, ...withoutExecution } = STEP;
    const submit = { ...withoutExecution, fields: {}, expectedRevision: 0 };
    expect(WorkflowHumanFormSubmitRequestSchema.safeParse(submit).success).toBe(false);
  });

  it("refuses the artifact list a form no longer has", () => {
    const submit = { ...STEP, fields: {}, expectedRevision: 0, attachmentArtifactIds: [] };
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
