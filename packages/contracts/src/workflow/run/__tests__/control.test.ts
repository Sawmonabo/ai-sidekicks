// The acts on a run come from the screen, the command line and an agent's tools. These tests
// hold the rules those acts rely on: the cancel reason's cap counts bytes, not characters, a
// re-pin names both versions, and a retry is a new run.
import { describe, expect, it } from "vitest";

import {
  WorkflowRunCancelRequestSchema,
  WorkflowRunResumeResponseSchema,
  WorkflowRunRetryResponseSchema,
} from "../control.js";
import { WORKFLOW_CANCEL_REASON_BYTE_CAP } from "../run.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";

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

describe("workflow.runResume", () => {
  it("accepts a re-pin naming both versions", () => {
    const reply = {
      workflowRunId: RUN_ID,
      state: "running",
      repinnedFromWorkflowVersionId: "wfv-4",
      repinnedToWorkflowVersionId: "wfv-5",
    };
    expect(WorkflowRunResumeResponseSchema.safeParse(reply).success).toBe(true);
  });

  it("refuses a re-pin naming only the version it left", () => {
    const reply = {
      workflowRunId: RUN_ID,
      state: "running",
      repinnedFromWorkflowVersionId: "wfv-4",
    };
    expect(WorkflowRunResumeResponseSchema.safeParse(reply).success).toBe(false);
  });
});

describe("workflow.runRetry", () => {
  it("refuses a retry that answers with its own source run", () => {
    const reply = { workflowRunId: RUN_ID, sourceWorkflowRunId: RUN_ID, state: "new" };
    expect(WorkflowRunRetryResponseSchema.safeParse(reply).success).toBe(false);
  });
});
