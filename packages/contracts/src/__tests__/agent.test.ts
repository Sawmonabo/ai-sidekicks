// A running agent's switch is the one verb a person uses to move an agent, and the
// live agent list is what every window draws. These cases hold that a switch never
// names an account, never arrives empty, and that an agent carries no lifecycle state.
import { describe, expect, it } from "vitest";

import { AgentConfigUpdateRequestSchema, AgentListEntrySchema } from "../agent.js";

const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const DEFINITION_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "66666666-6666-4666-8666-666666666666";

const LIST_ENTRY = {
  agentId: AGENT_ID,
  name: "reviewer",
  binding: {
    driverName: "codex",
    modelId: "gpt-5.5",
    providerAccountId: null,
    effort: "medium",
    outputSpeed: "fast",
  },
  pendingSwitch: {
    status: "pending",
    switchId: "switch-1",
    appliesAt: "run_boundary",
    interruptRequested: false,
    pendingAxes: { driverName: "claude", modelId: "opus" },
  },
  resolvedConfiguration: {
    resolvedFromDefinitionId: DEFINITION_ID,
    resolvedBinding: {
      driverName: "codex",
      modelId: "gpt-5.5",
      providerAccountId: null,
      effort: "medium",
    },
    executionPostureMode: "reviewed",
    toolAllowlist: null,
    instructions: "Review the change.",
    goal: null,
  },
  ancestry: [
    { kind: "agent", agentId: "77777777-7777-4777-8777-777777777777" },
    { kind: "providerChild", runId: RUN_ID, childHandle: "child-1" },
  ],
  createdAt: "2026-09-29T10:00:00Z",
} as const;

describe("agent.configUpdate", () => {
  it("accepts a provider switch that interrupts the run first", () => {
    const request = {
      agentId: AGENT_ID,
      driverName: "claude",
      modelId: "opus",
      interruptAndSwitch: true,
    };
    expect(AgentConfigUpdateRequestSchema.safeParse(request).success).toBe(true);
  });

  it("refuses an account, which moves on the provider surface", () => {
    const request = { agentId: AGENT_ID, modelId: "opus", providerAccountId: "claude-work" };
    expect(AgentConfigUpdateRequestSchema.safeParse(request).success).toBe(false);
  });

  it("refuses an update that moves nothing", () => {
    expect(AgentConfigUpdateRequestSchema.safeParse({ agentId: AGENT_ID }).success).toBe(false);
    expect(
      AgentConfigUpdateRequestSchema.safeParse({ agentId: AGENT_ID, interruptAndSwitch: true })
        .success,
    ).toBe(false);
  });
});

describe("agent.list entries", () => {
  it("accepts an agent with a switch waiting and the definition it came from", () => {
    expect(AgentListEntrySchema.safeParse(LIST_ENTRY).success).toBe(true);
  });

  it("refuses a lifecycle state", () => {
    expect(AgentListEntrySchema.safeParse({ ...LIST_ENTRY, state: "ready" }).success).toBe(false);
  });
});
