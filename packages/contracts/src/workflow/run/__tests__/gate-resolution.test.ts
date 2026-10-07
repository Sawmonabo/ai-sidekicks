// A gate's answers are the append-only truth a run's rebuild reads. These tests hold the rule the
// rebuild depends on: an approval step's answer names its node, and a chain's question names none.
import { describe, expect, it } from "vitest";

import { WorkflowGateResolutionSchema } from "../gate-resolution.js";

const RESOLUTION = {
  gateResolutionId: "gr-1",
  workflowRunId: "33333333-3333-4333-8333-333333333333",
  sequence: 1,
  approvalRequestId: "44444444-4444-4444-8444-444444444444",
  outcome: "approved",
  deviceId: "desktop-1",
  resolvedAt: "2026-09-29T14:14:00Z",
  decisionContext: {},
};

describe("WorkflowGateResolutionSchema", () => {
  it("names the node on an approval step's answer and none on a chain's", () => {
    const approval = { ...RESOLUTION, gateKind: "human.approval", nodeId: "approve" };
    expect(WorkflowGateResolutionSchema.safeParse(approval).success).toBe(true);
    const { nodeId: _nodeId, ...approvalWithoutNode } = approval;
    expect(WorkflowGateResolutionSchema.safeParse(approvalWithoutNode).success).toBe(false);
    const chain = { ...RESOLUTION, gateKind: "chain" };
    expect(WorkflowGateResolutionSchema.safeParse(chain).success).toBe(true);
    expect(WorkflowGateResolutionSchema.safeParse({ ...chain, nodeId: "approve" }).success).toBe(
      false,
    );
  });
});
