// The composer's address: resolved from what the wire says, and never a guess.

import { describe, expect, it } from "vitest";

import type { StoredEntity } from "#renderer/store/session/entities/vocabulary.js";
import { resolveComposerTarget, type ComposerTargetInput } from "./target.js";
import { agentPane } from "./Composer.test-support.js";

const AGENT: StoredEntity = {
  kind: "agent",
  id: "agent-implementer",
  state: "running",
  body: {
    name: "Ada",
    driverName: "claude",
    model: "opus",
    effort: "high",
  },
};

const RUN: StoredEntity = {
  kind: "run",
  id: "run-01",
  state: "running",
  touchedAt: "2026-01-01T11:05:00.000Z",
  body: { agentId: "agent-implementer", runVersion: 4 },
};

function input(overrides: Partial<ComposerTargetInput> = {}): ComposerTargetInput {
  return {
    sessionId: "session-1",
    focusedPane: undefined,
    agents: {},
    runs: {},
    ...overrides,
  };
}

describe("resolveComposerTarget — never guesses, and never sends with no target", () => {
  it("takes the provider-bound path only when the pane names an agent with a seen run", () => {
    const target = resolveComposerTarget(
      input({
        focusedPane: agentPane(AGENT.id),
        agents: { [AGENT.id]: AGENT },
        runs: { [RUN.id]: RUN },
      }),
    );

    expect(target).toStrictEqual({
      path: "provider-bound",
      sessionId: "session-1",
      agentId: AGENT.id,
      driverName: "claude",
      targetRunId: RUN.id,
      expectedRunVersion: 4,
    });
  });

  it("falls back to the session path when the agent has no run this store has seen", () => {
    // The negative control for the arm above: same pane, no run, so the session is addressed.
    const target = resolveComposerTarget(
      input({
        focusedPane: agentPane(AGENT.id),
        agents: { [AGENT.id]: AGENT },
      }),
    );
    expect(target.path).toBe("session-message");
  });

  it("addresses the session once every run this agent has is terminal", () => {
    // The steer path would resolve to a run the daemon will not move again, so every send would be
    // refused. The negative control is the first case: a run still going takes provider-bound.
    const settled: StoredEntity = { ...RUN, state: "failed" };
    const target = resolveComposerTarget(
      input({
        focusedPane: agentPane(AGENT.id),
        agents: { [AGENT.id]: AGENT },
        runs: { [settled.id]: settled },
      }),
    );
    expect(target.path).toBe("session-message");
  });
});
