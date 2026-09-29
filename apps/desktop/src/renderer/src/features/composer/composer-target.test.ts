// The composer's address: resolved from wire truth, and never a guess.

import { describe, expect, it } from "vitest";

import type { StoredEntity } from "@renderer/store/session/entities/entities.js";
import { resolveComposerTarget, type ComposerTargetInput } from "./composer-target.js";

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
        focusedPane: { kind: "agents", entity: { kind: "agent", id: AGENT.id } },
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
      providerFailureDetail: undefined,
    });
  });

  it("falls back to the session path when the agent has no run this store has seen", () => {
    // The negative control for the arm above: same focused pane, no run — so the
    // composer addresses the session rather than guessing which run to steer.
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agents", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
      }),
    );
    expect(target.path).toBe("session-message");
  });

  it("takes the newest run when an agent has several", () => {
    const older: StoredEntity = { ...RUN, id: "run-00", touchedAt: "2026-01-01T10:00:00.000Z" };
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agents", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
        runs: { [older.id]: older, [RUN.id]: RUN },
      }),
    );
    expect(target.path === "provider-bound" && target.targetRunId).toBe(RUN.id);
  });

  it("passes over a settled run touched later in favour of the one still going", () => {
    const settled: StoredEntity = {
      ...RUN,
      id: "run-02",
      state: "completed",
      touchedAt: "2026-01-01T12:00:00.000Z",
    };
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agents", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
        runs: { [RUN.id]: RUN, [settled.id]: settled },
      }),
    );
    expect(target.path === "provider-bound" && target.targetRunId).toBe(RUN.id);
  });

  it("addresses the session once every run this agent has is terminal", () => {
    // The steer path would resolve to a run the daemon will not move again, so every
    // send would be refused and the new-turn path would be unreachable for the rest
    // of the session. The negative control is the case above: the same pane and the
    // same agent, with one run still going, still takes the provider-bound path.
    const settled: StoredEntity = { ...RUN, state: "failed" };
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agents", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
        runs: { [settled.id]: settled },
      }),
    );
    expect(target.path).toBe("session-message");
  });
});
