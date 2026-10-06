// The step events the run's step panel and the attention list read: a gate's answer names the
// device and pinned version that answered it, and a wait's event names the spent account the
// attention list groups by exactly when the wait is on an account.
import { describe, expect, it } from "vitest";

import { buildSessionCreatedEvent } from "../../../../event/__tests__/session.test-support.js";
import { SessionEventSchema } from "../../../../event/session.js";
import { WorkflowGateResolvedPayloadSchema } from "../events.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const STEP = { workflowRunId: RUN_ID, nodeId: "review-form", executionIndex: 4 };

describe("workflow.gate_resolved", () => {
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

describe("workflow.phase_suspended", () => {
  const suspended = (payload: Record<string, unknown>) => ({
    ...buildSessionCreatedEvent(),
    category: "workflow_phase_lifecycle",
    type: "workflow.phase_suspended",
    payload: { sessionId: SESSION_ID, ...STEP, attempt: 1, ...payload },
  });

  it("accepts an account wait naming its spent account, with or without a resume instant", () => {
    const scheduled = {
      waitCause: "account",
      providerAccountId: "acct-1",
      resumeAt: "2026-09-29T19:00:00Z",
    };
    expect(SessionEventSchema.safeParse(suspended(scheduled)).success).toBe(true);
    const unscheduled = { waitCause: "account", providerAccountId: "acct-1" };
    expect(SessionEventSchema.safeParse(suspended(unscheduled)).success).toBe(true);
  });

  it("refuses an account wait that names no account, so the attention list can group it", () => {
    expect(SessionEventSchema.safeParse(suspended({ waitCause: "account" })).success).toBe(false);
  });

  it("refuses an account or a resume instant on a wait for a person", () => {
    const withAccount = { waitCause: "approval", providerAccountId: "acct-1" };
    expect(SessionEventSchema.safeParse(suspended(withAccount)).success).toBe(false);
    const withResume = { waitCause: "form", resumeAt: "2026-09-29T19:00:00Z" };
    expect(SessionEventSchema.safeParse(suspended(withResume)).success).toBe(false);
  });
});
