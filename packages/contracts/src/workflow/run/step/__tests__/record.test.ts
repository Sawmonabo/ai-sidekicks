// A run's steps cross from the daemon to the run page, the runs table and the live
// stream. These tests hold the step record's own rules: only a waiting step names its
// cause and its instants, only an account wait names its spent account, only a reply wait holds
// a question and only an answered step its
// answer, an inline payload stays under its cap, and a failure's details never travel without
// its code, and only a failed step says how its process exited.
import { describe, expect, it } from "vitest";

import { WorkflowStepErrorSchema } from "../../../definition/document.js";
import {
  WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP,
  WorkflowPayloadRefSchema,
  WorkflowStepSchema,
} from "../record.js";

const EMPTY = { kind: "inline", items: [] };
const STEP = {
  workflowRunId: "33333333-3333-4333-8333-333333333333",
  nodeId: "approve",
  attempt: 1,
  executionIndex: 3,
  source: [{ nodeId: "tests", outputIndex: 0, executionIndex: 2 }, null],
  startedAt: "2026-09-29T14:00:00Z",
  inputRef: { kind: "inline", items: [{ json: { ok: true } }] },
  outputRef: EMPTY,
  logRef: EMPTY,
};
const SPENT_ACCOUNT = { providerAccountId: "acct-1", provider: "codex", label: "Work" };

describe("WorkflowStepSchema", () => {
  it("accepts a waiting step with its deadline, and one parked with the instant it resumes", () => {
    const waiting = {
      ...STEP,
      status: "waiting",
      waitCause: "approval",
      waitDeadlineAt: "2026-09-30T06:00:00-04:00",
    };
    expect(WorkflowStepSchema.safeParse(waiting).success).toBe(true);
    const parked = {
      ...STEP,
      status: "waiting",
      waitCause: "account",
      waitAccount: SPENT_ACCOUNT,
      resumeAt: "2026-09-29T19:00:00Z",
    };
    expect(WorkflowStepSchema.safeParse(parked).success).toBe(true);
  });

  it("names the spent account on an account wait, and on no other step", () => {
    const parked = { ...STEP, status: "waiting", waitCause: "account" };
    expect(WorkflowStepSchema.safeParse(parked).success).toBe(false);
    const approving = { ...STEP, status: "waiting", waitCause: "approval" };
    expect(WorkflowStepSchema.safeParse({ ...approving, waitAccount: SPENT_ACCOUNT }).success).toBe(
      false,
    );
  });

  it("refuses a waiting step with no cause", () => {
    expect(WorkflowStepSchema.safeParse({ ...STEP, status: "waiting" }).success).toBe(false);
  });

  it("refuses a cause on a step that is not waiting", () => {
    const heldByMemory = { ...STEP, status: "waiting-memory", waitCause: "account" };
    expect(WorkflowStepSchema.safeParse(heldByMemory).success).toBe(false);
  });

  it("refuses a resume instant on a step that is not waiting", () => {
    const canceled = { ...STEP, status: "canceled", resumeAt: "2026-09-29T19:00:00Z" };
    expect(WorkflowStepSchema.safeParse(canceled).success).toBe(false);
  });

  it("carries a question only while waiting for a reply, and an answer only once answered", () => {
    const question = {
      questionId: "66666666-6666-4666-8666-666666666666",
      waitId: "77777777-7777-4777-8777-777777777777",
      prompt: "Which label?",
    };
    const asking = { ...STEP, status: "waiting", waitCause: "reply" };
    expect(WorkflowStepSchema.safeParse({ ...asking, question }).success).toBe(true);
    expect(WorkflowStepSchema.safeParse(asking).success).toBe(false);
    const approving = { ...STEP, status: "waiting", waitCause: "approval" };
    expect(WorkflowStepSchema.safeParse({ ...approving, question }).success).toBe(false);
    const resolution = { kind: "approved", at: "2026-09-29T14:14:00Z" };
    expect(WorkflowStepSchema.safeParse({ ...STEP, status: "succeeded", resolution }).success).toBe(
      true,
    );
    expect(WorkflowStepSchema.safeParse({ ...approving, resolution }).success).toBe(false);
  });

  it("carries how its process exited only on a failed step", () => {
    const processExit = { exitCode: 1, outputTail: "2 tests failed" };
    const failed = { ...STEP, status: "failed", processExit };
    expect(WorkflowStepSchema.safeParse(failed).success).toBe(true);
    expect(WorkflowStepSchema.safeParse({ ...failed, status: "succeeded" }).success).toBe(false);
  });
});

describe("WorkflowPayloadRefSchema", () => {
  const itemsOfBytes = (byteCount: number): unknown[] => {
    // `[{"json":"…"}]` wraps the string in 13 bytes of JSON.
    return [{ json: "a".repeat(byteCount - 13) }];
  };

  it("accepts an inline payload of exactly the cap", () => {
    const payload = { kind: "inline", items: itemsOfBytes(WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP) };
    expect(WorkflowPayloadRefSchema.safeParse(payload).success).toBe(true);
  });

  it("refuses an inline payload one byte over the cap", () => {
    const payload = {
      kind: "inline",
      items: itemsOfBytes(WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP + 1),
    };
    expect(WorkflowPayloadRefSchema.safeParse(payload).success).toBe(false);
  });
});

describe("WorkflowStepErrorSchema", () => {
  it("accepts a coded failure with its details", () => {
    const timedOut = {
      message: "The approval step timed out",
      code: "workflow.step_timed_out",
      details: { cause: "step_timeout", limitMs: 3_600_000 },
    };
    expect(WorkflowStepErrorSchema.safeParse(timedOut).success).toBe(true);
  });

  it("refuses details with no code", () => {
    const uncoded = { message: "failed", details: { cause: "step_timeout" } };
    expect(WorkflowStepErrorSchema.safeParse(uncoded).success).toBe(false);
  });

  it("carries the failing item's index from 0, and no negative one", () => {
    const itemFailure = { message: "The summary came back empty", itemIndex: 0 };
    expect(WorkflowStepErrorSchema.safeParse(itemFailure).success).toBe(true);
    expect(WorkflowStepErrorSchema.safeParse({ ...itemFailure, itemIndex: -1 }).success).toBe(
      false,
    );
  });
});
