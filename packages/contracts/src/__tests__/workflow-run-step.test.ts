// One step is answered and read from the run's step panel. These tests hold what that
// panel depends on: an approval answered in the approvals' own words, for a step or a
// chain's question, a form addressed by the step it waits on, and a verification that
// names its first divergence exactly when it fails.
import { describe, expect, it } from "vitest";

import {
  WorkflowGateChainVerifyResponseSchema,
  WorkflowGateResolveRequestSchema,
  WorkflowGateResolvedPayloadSchema,
  WorkflowHumanFormReadResponseSchema,
  WorkflowHumanFormSubmitRequestSchema,
  WorkflowStepReadRequestSchema,
} from "../workflow-run-step.js";

const RUN_ID = "wfr-1";
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

  it("names the answering device, and refuses a resolved event carrying a scope", () => {
    const event = {
      sessionId: SESSION_ID,
      workflowRunId: RUN_ID,
      outcome: "approved",
      gateResolutionId: "gr-1",
      deviceId: "desktop-1",
      rowHash: "b3:ab",
    };
    expect(WorkflowGateResolvedPayloadSchema.safeParse(event).success).toBe(true);
    const { deviceId: _deviceId, ...withoutDevice } = event;
    expect(WorkflowGateResolvedPayloadSchema.safeParse(withoutDevice).success).toBe(false);
    expect(
      WorkflowGateResolvedPayloadSchema.safeParse({ ...event, scope: "workflow-phase" }).success,
    ).toBe(false);
  });
});

describe("workflow.gateChainVerify", () => {
  it("accepts a failed check naming its first divergence", () => {
    const failed = {
      workflowRunId: RUN_ID,
      verified: false,
      rowsChecked: 7,
      firstDivergentSequence: 4,
      divergence: "row_hash_mismatch",
    };
    expect(WorkflowGateChainVerifyResponseSchema.safeParse(failed).success).toBe(true);
  });

  it("refuses a failed check that names no divergence", () => {
    const bare = { workflowRunId: RUN_ID, verified: false, rowsChecked: 7 };
    expect(WorkflowGateChainVerifyResponseSchema.safeParse(bare).success).toBe(false);
  });

  it("refuses a passed check that names a divergence", () => {
    const contradictory = {
      workflowRunId: RUN_ID,
      verified: true,
      rowsChecked: 7,
      divergence: "sequence_gap",
    };
    expect(WorkflowGateChainVerifyResponseSchema.safeParse(contradictory).success).toBe(false);
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
