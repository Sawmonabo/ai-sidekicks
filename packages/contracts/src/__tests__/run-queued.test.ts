// A run's creation row is the one record an agent started from a saved definition is
// brought into the session by, and the one the agent index rebuilds a child's linkage
// from. These cases hold that such an agent carries the configuration it was resolved
// from, and that the retired linkage words are refused rather than carried.
import { describe, expect, it } from "vitest";

import { RunQueuedPayloadSchema } from "../run-queued.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const RUN_ID = "0f2b4d5e-2222-4222-8222-222222222222";
const PARENT_RUN_ID = "0f2b4d5e-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";

const BINDING = {
  driverName: "codex",
  modelId: "gpt-5.5",
  providerAccountId: null,
  effort: "medium",
} as const;

const CHILD_FROM_DEFINITION = {
  sessionId: SESSION_ID,
  runId: RUN_ID,
  runVersion: 0,
  newState: "queued",
  agentId: AGENT_ID,
  parentRunId: PARENT_RUN_ID,
  reachedBy: "bridge_run",
  internalHelper: false,
  effectiveRunConfig: { tokenLimit: 200_000 },
  resolvedAgent: {
    agentId: AGENT_ID,
    name: "Reviewer",
    binding: BINDING,
    resolvedConfiguration: {
      resolvedFromDefinitionId: DEFINITION_ID,
      resolvedBinding: BINDING,
      executionPostureMode: "reviewed",
      toolAllowlist: null,
      instructions: "Review the change.",
      goal: null,
    },
    ancestry: [{ kind: "agent", agentId: "77777777-7777-4777-8777-777777777777" }],
    createdAt: "2026-09-30T10:00:00Z",
  },
  admittedModelFamily: "gpt-5",
} as const;

describe("run.queued", () => {
  it("records a child run, its linkage and the agent resolved from a saved definition", () => {
    expect(RunQueuedPayloadSchema.safeParse(CHILD_FROM_DEFINITION).success).toBe(true);
  });

  it("refuses a resolved agent that does not name the configuration it was resolved from", () => {
    const { resolvedConfiguration: _configuration, ...unresolved } =
      CHILD_FROM_DEFINITION.resolvedAgent;
    const payload = { ...CHILD_FROM_DEFINITION, resolvedAgent: unresolved };
    expect(RunQueuedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses the retired link kind and producing node", () => {
    for (const retired of [{ linkType: "spawn" }, { producingNodeId: "node-1" }]) {
      expect(
        RunQueuedPayloadSchema.safeParse({ ...CHILD_FROM_DEFINITION, ...retired }).success,
      ).toBe(false);
    }
  });
});
