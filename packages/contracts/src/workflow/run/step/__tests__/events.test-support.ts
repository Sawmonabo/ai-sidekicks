// Workflow step events several contracts tests parse.
import {
  buildSessionCreatedEvent,
  type WireSessionEvent,
} from "../../../../event/__tests__/session.test-support.js";

const RUN_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

/**
 * A valid `workflow.gate_resolved` payload: a gate approved from a named device against a pinned
 * workflow version.
 */
export const WORKFLOW_GATE_RESOLVED_PAYLOAD: Readonly<Record<string, unknown>> = {
  sessionId: SESSION_ID,
  workflowRunId: RUN_ID,
  definitionId: "wfd-1",
  workflowVersionId: "wfv-3",
  nodeId: "approve",
  outcome: "approved",
  gateResolutionId: "gr-1",
  deviceId: "desktop-1",
};

/** A `workflow.phase_suspended` event for one step's first attempt, waiting as `wait` says. */
export const buildPhaseSuspendedEvent = (wait: Record<string, unknown>): WireSessionEvent => ({
  ...buildSessionCreatedEvent(),
  category: "workflow_phase_lifecycle",
  type: "workflow.phase_suspended",
  payload: {
    sessionId: SESSION_ID,
    workflowRunId: RUN_ID,
    nodeId: "review-form",
    executionIndex: 4,
    attempt: 1,
    ...wait,
  },
});
