// A running agent's switch is the one verb a person uses to move an agent. These cases
// hold that every accepted update moves at least one member of the binding.
import { describe, expect, it } from "vitest";

import { AgentConfigUpdateRequestSchema } from "../methods.js";

const AGENT_ID = "44444444-4444-4444-8444-444444444444";

describe("agent.configUpdate", () => {
  it("accepts a provider switch that interrupts the run first", () => {
    const request = {
      agentId: AGENT_ID,
      driverName: "claude",
      modelId: "opus",
      largerWindow: null,
      interruptAndSwitch: true,
    };
    expect(AgentConfigUpdateRequestSchema.safeParse(request).success).toBe(true);
  });

  it("counts a move back to the default window as a move", () => {
    // `null` is the move to the default window, never an unset member.
    expect(
      AgentConfigUpdateRequestSchema.safeParse({ agentId: AGENT_ID, largerWindow: null }).success,
    ).toBe(true);
    // A model move names its window, so an omitted one only ever means unchanged.
    expect(
      AgentConfigUpdateRequestSchema.safeParse({ agentId: AGENT_ID, modelId: "opus" }).success,
    ).toBe(false);
  });

  it("refuses an update that moves nothing", () => {
    expect(AgentConfigUpdateRequestSchema.safeParse({ agentId: AGENT_ID }).success).toBe(false);
    expect(
      AgentConfigUpdateRequestSchema.safeParse({ agentId: AGENT_ID, interruptAndSwitch: true })
        .success,
    ).toBe(false);
  });
});
