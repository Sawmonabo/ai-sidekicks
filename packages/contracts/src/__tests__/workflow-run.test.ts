// A run's steps cross from the daemon to the run page, the runs table and the live
// stream. These tests hold the step record's own rules: only a waiting step names its
// cause and its instants, an inline payload stays under its cap, and a failure's
// details never travel without its code.
import { describe, expect, it } from "vitest";

import { WorkflowStepErrorSchema } from "../workflow-definition.js";
import {
  WORKFLOW_STEP_PAYLOAD_INLINE_BYTE_CAP,
  WorkflowPayloadRefSchema,
  WorkflowStepSchema,
} from "../workflow-run.js";

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
  logRef: { kind: "expired" },
};

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
      resumeAt: "2026-09-29T19:00:00Z",
    };
    expect(WorkflowStepSchema.safeParse(parked).success).toBe(true);
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
});
