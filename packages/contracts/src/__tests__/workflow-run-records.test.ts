// The runs table and the runs-needing-you section read run records. These tests hold the rules
// those readers depend on: a row whose duration, live step and wait cause agree with its status,
// a page that never outnumbers its total, and account lines standing above the runs that need a
// person, counted apart from them.
import { describe, expect, it } from "vitest";

import {
  WorkflowRunAttentionListResponseSchema,
  WorkflowRunListResponseSchema,
  WorkflowRunSummarySchema,
} from "../workflow-run-records.js";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const PARENT_RUN_ID = "33333333-3333-4333-8333-333333333333";
const RUN_ID = "44444444-4444-4444-8444-444444444444";
const WAITING_RUN_ID = "55555555-5555-4555-8555-555555555555";

const ROW = {
  workflowRunId: RUN_ID,
  definitionId: "wfd-1",
  definitionName: "Summarize subfolder",
  status: "running",
  mode: "sub-workflow",
  startedBy: { kind: "parentWorkflow", parentWorkflowRunId: PARENT_RUN_ID },
  startedAt: "2026-09-29T06:00:00Z",
  stepCount: 3,
  liveStep: { index: 4, total: 9, nodeName: "run tests" },
};

describe("workflow.runList", () => {
  it("accepts a going row with its live step and a finished row with its duration", () => {
    expect(WorkflowRunSummarySchema.safeParse(ROW).success).toBe(true);
    const { liveStep: _live, ...finished } = ROW;
    expect(
      WorkflowRunSummarySchema.safeParse({
        ...finished,
        status: "succeeded",
        durationMs: 401_000,
        startedBy: { kind: "user", userId: USER_ID },
      }).success,
    ).toBe(true);
  });

  it("refuses a row whose duration, live step or wait cause disagrees with its status", () => {
    expect(WorkflowRunSummarySchema.safeParse({ ...ROW, durationMs: 1_000 }).success).toBe(false);
    const finished = { ...ROW, status: "failed", durationMs: 1_000 };
    expect(WorkflowRunSummarySchema.safeParse(finished).success).toBe(false);
    expect(WorkflowRunSummarySchema.safeParse({ ...ROW, status: "waiting" }).success).toBe(false);
  });

  it("refuses a page holding more runs than its total", () => {
    const page = { runs: [ROW], totalCount: 0 };
    expect(WorkflowRunListResponseSchema.safeParse(page).success).toBe(false);
  });
});

describe("workflow.runAttentionList", () => {
  const account = {
    kind: "account",
    providerAccountId: "acct-claude-1",
    affectedRunCount: 6,
    waitingSince: "2026-09-29T05:00:00Z",
    resumeAt: "2026-09-29T10:00:00Z",
  };
  const approval = {
    kind: "run",
    workflowRunId: WAITING_RUN_ID,
    workflowName: "Nightly release",
    waitCause: "approval",
    waitingSince: "2026-09-29T06:10:00Z",
  };

  it("accepts the account lines above the runs waiting on a person", () => {
    const reply = { entries: [account, approval], waitingOnPersonCount: 1 };
    expect(WorkflowRunAttentionListResponseSchema.safeParse(reply).success).toBe(true);
  });

  it("refuses an account line below a run waiting on a person", () => {
    const reply = { entries: [approval, account], waitingOnPersonCount: 1 };
    expect(WorkflowRunAttentionListResponseSchema.safeParse(reply).success).toBe(false);
  });

  it("refuses a count that includes the account waits", () => {
    const reply = { entries: [account, approval], waitingOnPersonCount: 7 };
    expect(WorkflowRunAttentionListResponseSchema.safeParse(reply).success).toBe(false);
  });
});
