// The acts on a run come from the screen, the command line and an agent's tools. These
// tests hold what each act accepts and refuses: the start modes a caller may ask for,
// the cancel reason's byte cap, a re-pin that names both versions, a retry that is a
// new run, and the session a results post names.
import { describe, expect, it } from "vitest";

import {
  WorkflowCanceledPayloadSchema,
  WorkflowResultsPostRequestSchema,
  WorkflowRetryUnavailableDetailsSchema,
  WorkflowRunCancelRequestSchema,
  WorkflowRunResumeResponseSchema,
  WorkflowRunRetryResponseSchema,
  WorkflowRunStartRequestSchema,
  WorkflowRunStartResponseSchema,
} from "../workflow-run-control.js";
import { WORKFLOW_CANCEL_REASON_BYTE_CAP } from "../workflow-run.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

describe("workflow.runStart", () => {
  it("accepts a start from a chat with the inputs the trigger declares", () => {
    const start = {
      workflowVersionId: "wfv-5",
      sessionId: SESSION_ID,
      input: [{ json: { folder: "/work/docs", dryRun: false } }],
      mode: "chat",
    };
    expect(WorkflowRunStartRequestSchema.safeParse(start).success).toBe(true);
  });

  it("refuses a start asking for a mode only its own operation mints", () => {
    const start = { workflowVersionId: "wfv-5", mode: "retry" };
    expect(WorkflowRunStartRequestSchema.safeParse(start).success).toBe(false);
  });

  it("refuses a reply in a status a start cannot produce", () => {
    const reply = { workflowRunId: RUN_ID, sessionId: SESSION_ID, state: "waiting" };
    expect(WorkflowRunStartResponseSchema.safeParse(reply).success).toBe(false);
  });
});

describe("workflow.runCancel reason cap", () => {
  it("accepts a reason of exactly the cap in bytes", () => {
    const reason = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    expect(
      WorkflowRunCancelRequestSchema.safeParse({ workflowRunId: RUN_ID, reason }).success,
    ).toBe(true);
  });

  it("refuses a reason one byte over the cap", () => {
    const reason = "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP + 1);
    expect(
      WorkflowRunCancelRequestSchema.safeParse({ workflowRunId: RUN_ID, reason }).success,
    ).toBe(false);
  });

  it("refuses a multibyte reason over the cap in bytes though under it in characters", () => {
    const reason = "é".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP / 2 + 1);
    expect(reason.length).toBeLessThan(WORKFLOW_CANCEL_REASON_BYTE_CAP);
    expect(
      WorkflowRunCancelRequestSchema.safeParse({ workflowRunId: RUN_ID, reason }).success,
    ).toBe(false);
  });

  it("records a cancel with no reason, as a chain's stop makes, and caps one that has it", () => {
    const run = {
      sessionId: SESSION_ID,
      workflowRunId: RUN_ID,
      definitionId: "wfd-1",
      workflowVersionId: "wfv-5",
    };
    expect(WorkflowCanceledPayloadSchema.safeParse(run).success).toBe(true);
    const overCap = { ...run, reason: "a".repeat(WORKFLOW_CANCEL_REASON_BYTE_CAP + 1) };
    expect(WorkflowCanceledPayloadSchema.safeParse(overCap).success).toBe(false);
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

  it("refuses a retry refusal whose reason is outside the closed list", () => {
    expect(
      WorkflowRetryUnavailableDetailsSchema.safeParse({ reason: "source_running" }).success,
    ).toBe(true);
    expect(WorkflowRetryUnavailableDetailsSchema.safeParse({ reason: "expired" }).success).toBe(
      false,
    );
  });
});

describe("workflow.resultsPost", () => {
  it("refuses a post that names no session", () => {
    expect(WorkflowResultsPostRequestSchema.safeParse({ workflowRunId: RUN_ID }).success).toBe(
      false,
    );
  });
});
