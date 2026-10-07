// Run creation payloads several contracts tests parse.

/** The agent a fixture run is resolved into. */
export const AGENT_ID = "44444444-4444-4444-8444-444444444444";

const BINDING = {
  driverName: "codex",
  modelId: "gpt-5.5",
  providerAccountId: null,
  effort: "medium",
};

/** The agent a fixture child run resolved from a saved definition, with that configuration. */
export const RESOLVED_AGENT: Readonly<Record<string, unknown>> = {
  agentId: AGENT_ID,
  name: "Reviewer",
  binding: BINDING,
  resolvedConfiguration: {
    resolvedFromDefinitionId: "11111111-1111-4111-8111-111111111111",
    resolvedBinding: BINDING,
    toolAllowlist: null,
    instructions: "Review the change.",
    goal: null,
  },
  ancestry: [{ kind: "agent", agentId: "77777777-7777-4777-8777-777777777777" }],
  createdAt: "2026-09-30T10:00:00Z",
};

/**
 * A valid `run.queued` payload: a child run, its linkage and the agent resolved from a saved
 * definition.
 */
export const RUN_QUEUED_CHILD_PAYLOAD: Readonly<Record<string, unknown>> = {
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  runId: "0f2b4d5e-2222-4222-8222-222222222222",
  runVersion: 0,
  newState: "queued",
  parentRunId: "0f2b4d5e-3333-4333-8333-333333333333",
  reachedBy: "bridge_run",
  effectiveRunConfig: { tokenLimit: 200_000 },
  resolvedAgent: RESOLVED_AGENT,
  admittedModelFamily: "gpt-5",
};
