// A cancel reason is capped by its UTF-8 byte length, not its character count, so the
// same sentence is refused at the same size in every script.
import { describe, expect, it } from "vitest";

import {
  WORKFLOW_CANCEL_REASON_BYTE_CAP,
  WorkflowRunCancelRequestSchema,
} from "../workflow-run.js";

const RUN_ID = "wfr-1";

describe("WorkflowRunCancelRequestSchema reason cap", () => {
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
});
