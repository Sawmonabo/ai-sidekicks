// The two chip models: resolved from wire truth, and fail-closed where there is none.

import { describe, expect, it } from "vitest";

import type { ConsoleEntity } from "../../../console/store/index.js";
import {
  resolveComposerTarget,
  resolvePostureChipModel,
  resolveTargetChipModel,
  type ComposerTargetInput,
} from "./chip-models.js";

const AGENT: ConsoleEntity = {
  kind: "agent",
  id: "agent-implementer",
  state: "running",
  body: {
    name: "Ada",
    driverName: "claude",
    model: "opus",
    effort: "high",
    providerAccountLabel: "work",
  },
};

const RUN: ConsoleEntity = {
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
    channels: {},
    ...overrides,
  };
}

describe("resolveComposerTarget — never guesses, and never sends with no target", () => {
  it("takes the provider-bound path only when the pane names an agent with a seen run", () => {
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agent-console", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
        runs: { [RUN.id]: RUN },
      }),
    );

    expect(target).toStrictEqual({
      path: "provider-bound",
      sessionId: "session-1",
      agentId: AGENT.id,
      agentName: "Ada",
      targetRunId: RUN.id,
      expectedRunVersion: 4,
      runState: "running",
      providerFailureDetail: undefined,
    });
  });

  it("falls back to the channel path when the agent has no run this store has seen", () => {
    // The negative control for the arm above: same focused pane, no run — so the
    // composer addresses the session rather than guessing which run to steer.
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agent-console", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
      }),
    );
    expect(target.path).toBe("channel-message");
  });

  it("addresses the session's default channel by omitting one, never by picking one", () => {
    const target = resolveComposerTarget(
      input({
        channels: { "channel-a": { kind: "channel", id: "channel-a", body: { name: "main" } } },
      }),
    );
    // A channel exists in the partition and the pane names none, so the target
    // carries no channel id at all — which is what the wire reads as "the default".
    expect(target).toStrictEqual({
      path: "channel-message",
      sessionId: "session-1",
      channelId: undefined,
      workspaceId: undefined,
      channelLabel: undefined,
    });
  });

  it("takes the newest run when an agent has several", () => {
    const older: ConsoleEntity = { ...RUN, id: "run-00", touchedAt: "2026-01-01T10:00:00.000Z" };
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agent-console", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
        runs: { [older.id]: older, [RUN.id]: RUN },
      }),
    );
    expect(target.path === "provider-bound" && target.targetRunId).toBe(RUN.id);
  });
});

describe("resolveTargetChipModel — the binding clause is assembled, never defaulted", () => {
  it("joins the axes the wire supplied, in the order the design fixes", () => {
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agent-console", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
        runs: { [RUN.id]: RUN },
      }),
    );
    const model = resolveTargetChipModel(target, { [AGENT.id]: AGENT });

    expect(model.bindingClause).toBe("claude · opus · high");
    expect(model.payingAccountLabel).toBe("work");
  });

  it("supplies no clause at all when the wire supplied no axis", () => {
    // The negative control: an empty clause must be absent rather than an empty
    // string, because an empty string renders as a chip that says nothing.
    const target = resolveComposerTarget(input());
    expect(resolveTargetChipModel(target, {}).bindingClause).toBeUndefined();
  });
});

describe("resolvePostureChipModel — the stamped posture only", () => {
  it("reads a stamped posture off the target run", () => {
    const stamped = {
      mode: "workspace-sandboxed",
      credentialPolicyRef: "sha256:abc",
      networkAccess: "none",
      writableRoots: ["/repo"],
    };
    const run: ConsoleEntity = { ...RUN, body: { ...RUN.body, executionPosture: stamped } };
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agent-console", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
        runs: { [run.id]: run },
      }),
    );

    expect(resolvePostureChipModel(target, { [run.id]: run }).stamped).toStrictEqual(stamped);
  });

  it("reports no posture on a run the daemon has not stamped one on", () => {
    const target = resolveComposerTarget(
      input({
        focusedPane: { kind: "agent-console", entity: { kind: "agent", id: AGENT.id } },
        agents: { [AGENT.id]: AGENT },
        runs: { [RUN.id]: RUN },
      }),
    );
    expect(resolvePostureChipModel(target, { [RUN.id]: RUN }).stamped).toBeUndefined();
  });

  it("reports no posture on the channel path, where no run exists to have one", () => {
    expect(resolvePostureChipModel(resolveComposerTarget(input()), {}).stamped).toBeUndefined();
  });
});
