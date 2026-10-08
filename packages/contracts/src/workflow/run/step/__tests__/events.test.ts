// The workflow events a run appends are what its rows rebuild from, so each must parse through the
// session event union as its own type and no other. These tests hold that, and the rules the step
// panel and the attention list read: a gate's answer names the device and pinned version that
// answered it, and a wait's event names its cause from the set and the spent account the
// attention list groups by exactly when the wait is on an account.
import { describe, expect, it } from "vitest";

import { buildSessionCreatedEvent } from "../../../../event/__tests__/session.test-support.js";
import type { EventCategory } from "../../../../event/envelope.js";
import { SessionEventSchema } from "../../../../event/session.js";
import { WorkflowGateResolvedPayloadSchema } from "../events.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const PINNED_RUN = {
  sessionId: SESSION_ID,
  workflowRunId: RUN_ID,
  definitionId: "wfd-1",
  workflowVersionId: "wfv-3",
};
const STEP = {
  sessionId: SESSION_ID,
  workflowRunId: RUN_ID,
  nodeId: "review-form",
  executionIndex: 4,
  attempt: 1,
};
const EMPTY = { kind: "inline", items: [] };

// One sample payload per registered workflow event type, with the category it is registered under;
// `workflow.run_deleted` is left out, since its payload names only the run, which
// `workflow.canceled` accepts too.
const SAMPLES: ReadonlyArray<{
  type: string;
  category: EventCategory;
  payload: Record<string, unknown>;
}> = [
  {
    type: "workflow.started",
    category: "workflow_lifecycle",
    payload: { ...PINNED_RUN, mode: "manual", startedBy: { kind: "user", deviceId: "desktop-1" } },
  },
  {
    type: "workflow.resumed",
    category: "workflow_lifecycle",
    payload: {
      ...PINNED_RUN,
      resumptionPoint: { activeSteps: [], pendingGates: ["review-form"] },
    },
  },
  {
    type: "workflow.canceled",
    category: "workflow_lifecycle",
    payload: { ...PINNED_RUN, reason: "Wrong branch." },
  },
  {
    type: "workflow.results_posted",
    category: "workflow_lifecycle",
    payload: { sessionId: SESSION_ID, workflowRunId: RUN_ID },
  },
  {
    type: "workflow.phase_suspended",
    category: "workflow_phase_lifecycle",
    payload: { ...STEP, waitCause: "form" },
  },
  {
    type: "workflow.step_started",
    category: "workflow_phase_lifecycle",
    payload: { ...STEP, inputRef: EMPTY },
  },
  {
    type: "workflow.step_finished",
    category: "workflow_phase_lifecycle",
    payload: { ...STEP, outputRef: EMPTY, logRef: EMPTY },
  },
  {
    type: "workflow.step_failed",
    category: "workflow_phase_lifecycle",
    payload: { ...STEP, error: { message: "Exit 1" }, failedItemIndex: 0 },
  },
  { type: "workflow.step_canceled", category: "workflow_phase_lifecycle", payload: STEP },
  {
    type: "workflow.step_skipped",
    category: "workflow_phase_lifecycle",
    payload: { ...STEP, reason: "no-items" },
  },
  {
    type: "workflow.gate_resolved",
    category: "workflow_gate_resolution",
    payload: {
      ...PINNED_RUN,
      nodeId: "approve",
      outcome: "approved",
      gateResolutionId: "gr-1",
      deviceId: "desktop-1",
    },
  },
];

const sessionEvent = (type: string, category: EventCategory, payload: Record<string, unknown>) => ({
  ...buildSessionCreatedEvent(),
  category,
  type,
  payload,
});

describe("workflow events in the session event union", () => {
  it("parses each type into its own payload and refuses its payload under any other type", () => {
    for (const sample of SAMPLES) {
      const parsed = SessionEventSchema.safeParse(
        sessionEvent(sample.type, sample.category, sample.payload),
      );
      expect(parsed.success, sample.type).toBe(true);
      expect(parsed.data?.type).toBe(sample.type);
      expect(parsed.data?.payload).toEqual(sample.payload);
      for (const other of SAMPLES.filter((candidate) => candidate.type !== sample.type)) {
        const misnamed = sessionEvent(other.type, other.category, sample.payload);
        expect(
          SessionEventSchema.safeParse(misnamed).success,
          `${sample.type} as ${other.type}`,
        ).toBe(false);
      }
    }
  });
});

describe("workflow.gate_resolved", () => {
  it("names the answering device and the pinned version", () => {
    const event = {
      ...PINNED_RUN,
      outcome: "approved",
      gateResolutionId: "gr-1",
      deviceId: "desktop-1",
    };
    expect(WorkflowGateResolvedPayloadSchema.safeParse(event).success).toBe(true);
    const { deviceId: _deviceId, ...withoutDevice } = event;
    expect(WorkflowGateResolvedPayloadSchema.safeParse(withoutDevice).success).toBe(false);
    const { workflowVersionId: _workflowVersionId, ...withoutVersion } = event;
    expect(WorkflowGateResolvedPayloadSchema.safeParse(withoutVersion).success).toBe(false);
  });
});

describe("workflow.phase_suspended", () => {
  const suspended = (payload: Record<string, unknown>) =>
    sessionEvent("workflow.phase_suspended", "workflow_phase_lifecycle", { ...STEP, ...payload });

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

  it("refuses a cause outside the set, and an account or a resume instant on a wait for a person", () => {
    expect(SessionEventSchema.safeParse(suspended({ waitCause: "memory" })).success).toBe(false);
    const withAccount = { waitCause: "approval", providerAccountId: "acct-1" };
    expect(SessionEventSchema.safeParse(suspended(withAccount)).success).toBe(false);
    const withResume = { waitCause: "form", resumeAt: "2026-09-29T19:00:00Z" };
    expect(SessionEventSchema.safeParse(suspended(withResume)).success).toBe(false);
  });
});
