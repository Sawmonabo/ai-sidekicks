// The acts on a run come from the screen, the command line and an agent's tools. These tests
// hold the rules those acts rely on: the cancel reason's cap counts bytes, not characters, a re-pin
// names both versions or neither, a resumed run says where it picks up, a start's session and
// project are the daemon's to refuse together, and a retry is a new run.
import { describe, expect, it } from "vitest";

import {
  WorkflowResumedPayloadSchema,
  WorkflowRunCancelRequestSchema,
  WorkflowRunResumeResponseSchema,
  WorkflowRunRetryResponseSchema,
  WorkflowRunStartRequestSchema,
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
} from "../control.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

describe("workflow.runCancel reason cap", () => {
  it("accepts a reason whose JSON encoding is exactly the cap in bytes", () => {
    const reason = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP - 2);
    expect(
      WorkflowRunCancelRequestSchema.safeParse({ workflowRunId: RUN_ID, reason }).success,
    ).toBe(true);
  });

  it("refuses a multibyte reason over the cap in bytes though under it in characters", () => {
    const reason = "é".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP / 2 + 1);
    expect(reason.length).toBeLessThan(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    expect(
      WorkflowRunCancelRequestSchema.safeParse({ workflowRunId: RUN_ID, reason }).success,
    ).toBe(false);
  });
});

describe("a resume's re-pin", () => {
  const RUN_EVENT = {
    sessionId: SESSION_ID,
    workflowRunId: RUN_ID,
    definitionId: "wfd-1",
    workflowVersionId: "wfv-4",
  };
  const resumptionPoint = {
    activeSteps: [{ nodeId: "tests", attempt: 2, executionIndex: 5 }],
    pendingGates: ["approve"],
  };
  const repin = { repinnedFromWorkflowVersionId: "wfv-4", repinnedToWorkflowVersionId: "wfv-5" };

  it("names both versions or neither, on the reply and on the resumed event", () => {
    const reply = { workflowRunId: RUN_ID, state: "running" };
    const resumed = { ...RUN_EVENT, resumptionPoint };
    for (const [schema, base] of [
      [WorkflowRunResumeResponseSchema, reply],
      [WorkflowResumedPayloadSchema, resumed],
    ] as const) {
      expect(schema.safeParse(base).success).toBe(true);
      expect(schema.safeParse({ ...base, ...repin }).success).toBe(true);
      const { repinnedToWorkflowVersionId: _to, ...onlyFrom } = repin;
      expect(schema.safeParse({ ...base, ...onlyFrom }).success).toBe(false);
      const { repinnedFromWorkflowVersionId: _from, ...onlyTo } = repin;
      expect(schema.safeParse({ ...base, ...onlyTo }).success).toBe(false);
    }
  });

  it("refuses a resumed event that does not say where the run picks up", () => {
    expect(WorkflowResumedPayloadSchema.safeParse({ ...RUN_EVENT, ...repin }).success).toBe(false);
  });
});

describe("workflow.runStart", () => {
  it("accepts a session and a project together, which the daemon refuses on a project session", () => {
    const start = { workflowVersionId: "wfv-5", sessionId: SESSION_ID, projectId: PROJECT_ID };
    expect(WorkflowRunStartRequestSchema.safeParse(start).success).toBe(true);
  });
});

describe("workflow.runRetry", () => {
  it("refuses a retry that answers with its own source run", () => {
    const reply = { workflowRunId: RUN_ID, sourceWorkflowRunId: RUN_ID, state: "new" };
    expect(WorkflowRunRetryResponseSchema.safeParse(reply).success).toBe(false);
  });
});
