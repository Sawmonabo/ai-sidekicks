// A run's creation row is the one record an agent started from a saved definition is
// brought into the session by, and the one the agent index rebuilds a child's linkage
// from. These cases hold that such an agent carries the configuration it was resolved
// from, and that a run names exactly one agent.
import { describe, expect, it } from "vitest";

import { RunQueuedPayloadSchema } from "../queued.js";
import { AGENT_ID, RESOLVED_AGENT, RUN_QUEUED_CHILD_PAYLOAD } from "./queued.test-support.js";

describe("run.queued", () => {
  it("records a child run, its linkage and the agent resolved from a saved definition", () => {
    expect(RunQueuedPayloadSchema.safeParse(RUN_QUEUED_CHILD_PAYLOAD).success).toBe(true);
  });

  it("refuses a resolved agent that does not name the configuration it was resolved from", () => {
    const { resolvedConfiguration: _configuration, ...unresolved } = RESOLVED_AGENT;
    const payload = { ...RUN_QUEUED_CHILD_PAYLOAD, resolvedAgent: unresolved };
    expect(RunQueuedPayloadSchema.safeParse(payload).success).toBe(false);
  });

  it("refuses a run naming both an agent in the session and one resolved from a definition, or neither", () => {
    expect(
      RunQueuedPayloadSchema.safeParse({ ...RUN_QUEUED_CHILD_PAYLOAD, agentId: AGENT_ID }).success,
    ).toBe(false);
    const { resolvedAgent: _agent, ...namingNoAgent } = RUN_QUEUED_CHILD_PAYLOAD;
    expect(RunQueuedPayloadSchema.safeParse(namingNoAgent).success).toBe(false);
    // The lead's run names the session's lead as an agent already in it.
    expect(RunQueuedPayloadSchema.safeParse({ ...namingNoAgent, agentId: AGENT_ID }).success).toBe(
      true,
    );
  });
});
