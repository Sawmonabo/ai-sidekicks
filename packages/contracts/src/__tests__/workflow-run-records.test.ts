// The run page, the runs table, the runs-needing-you section and the live stream all
// read run records. These tests hold what those readers depend on: the run read's
// chain and capture facts, a row that says whether its run is going, a page that never
// outnumbers its total, and account lines standing above the runs that need a person.
import { describe, expect, it } from "vitest";

import {
  WorkflowRunAttentionListResponseSchema,
  WorkflowRunListRequestSchema,
  WorkflowRunListResponseSchema,
  WorkflowRunReadResponseSchema,
  WorkflowRunSummarySchema,
  WorkflowSubscribeNotificationSchema,
} from "../workflow-run-records.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";

const ROW = {
  workflowRunId: "wfr-2",
  definitionId: "wfd-1",
  definitionName: "Summarize subfolder",
  status: "running",
  mode: "sub-workflow",
  startedBy: { kind: "parentWorkflow", parentWorkflowRunId: "wfr-1" },
  startedAt: "2026-09-29T06:00:00Z",
  stepCount: 3,
  liveStep: { index: 4, total: 9, nodeName: "run tests" },
};

describe("workflow.runRead", () => {
  const run = {
    workflowRunId: "wfr-2",
    sessionId: SESSION_ID,
    definitionId: "wfd-1",
    workflowVersionId: "wfv-5",
    state: "succeeded",
    mode: "sub-workflow",
    startedBy: { kind: "parentWorkflow", parentWorkflowRunId: "wfr-1" },
    chainRoot: {
      runId: "wfr-1",
      workflowId: "wfd-0",
      workflowName: "Summarize folder",
      startedAt: "2026-09-29T06:00:00Z",
    },
    executionContextCaptured: true,
    keep: false,
    steps: [],
    startedAt: "2026-09-29T06:00:01Z",
    endedAt: "2026-09-29T06:04:00Z",
  };

  it("accepts a chained run that captured its checkout", () => {
    expect(WorkflowRunReadResponseSchema.safeParse(run).success).toBe(true);
  });

  it("refuses a run read that does not say whether it captured its checkout", () => {
    const { executionContextCaptured: _dropped, ...withoutCapture } = run;
    expect(WorkflowRunReadResponseSchema.safeParse(withoutCapture).success).toBe(false);
  });
});

describe("workflow.runList", () => {
  it("accepts the four filters and the version scope", () => {
    const request = {
      definitionId: "wfd-1",
      workflowVersionId: "wfv-5",
      status: ["failed"],
      mode: ["trigger", "webhook"],
      startedAfter: "2026-09-22T00:00:00Z",
    };
    expect(WorkflowRunListRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses a filter the runs table does not have", () => {
    expect(WorkflowRunListRequestSchema.safeParse({ tag: "nightly" }).success).toBe(false);
  });

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

  it("refuses a going row with a duration", () => {
    expect(WorkflowRunSummarySchema.safeParse({ ...ROW, durationMs: 1_000 }).success).toBe(false);
  });

  it("refuses a finished row with a live step", () => {
    const finished = { ...ROW, status: "failed", durationMs: 1_000 };
    expect(WorkflowRunSummarySchema.safeParse(finished).success).toBe(false);
  });

  it("refuses a waiting row that does not name its cause", () => {
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
    workflowRunId: "wfr-3",
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

  it("refuses a person's line waiting on an account", () => {
    const reply = { entries: [{ ...approval, waitCause: "account" }], waitingOnPersonCount: 1 };
    expect(WorkflowRunAttentionListResponseSchema.safeParse(reply).success).toBe(false);
  });
});

describe("workflow.subscribe", () => {
  it("accepts the hold, a removal and a definition's removal", () => {
    for (const notification of [
      { kind: "runsPause", paused: true, waitingStartCount: 3 },
      { kind: "runsRemoved", workflowRunIds: ["wfr-1", "wfr-2"] },
      { kind: "definitionRemoved", definitionId: "wfd-1" },
    ]) {
      expect(WorkflowSubscribeNotificationSchema.safeParse(notification).success).toBe(true);
    }
  });

  it("refuses a removal that names no run", () => {
    const empty = { kind: "runsRemoved", workflowRunIds: [] };
    expect(WorkflowSubscribeNotificationSchema.safeParse(empty).success).toBe(false);
  });
});
