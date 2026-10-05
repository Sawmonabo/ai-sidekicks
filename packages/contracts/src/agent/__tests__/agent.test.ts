// A running agent's switch is the one verb a person uses to move an agent. These cases
// hold that every accepted update moves at least one member of the binding.
import { describe, expect, it } from "vitest";

import { AgentConfigUpdateRequestSchema } from "../agent.js";

const AGENT_ID = "44444444-4444-4444-8444-444444444444";

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

  it("refuses an update that moves nothing", () => {
    expect(AgentConfigUpdateRequestSchema.safeParse({ agentId: AGENT_ID }).success).toBe(false);
    expect(
      AgentConfigUpdateRequestSchema.safeParse({ agentId: AGENT_ID, interruptAndSwitch: true })
        .success,
    ).toBe(false);
  });
});
