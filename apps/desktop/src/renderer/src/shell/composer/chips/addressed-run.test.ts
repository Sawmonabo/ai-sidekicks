// Which run the composer points at, and the three readings that must not collapse.
//
// The failure this pins is silent and permanent: an agent whose newest run has
// settled keeps the composer on the steer path, so every later message resolves to
// a steer against a run the daemon will not move and comes back refused — with the
// new-turn path unreachable for the rest of the session.

import { describe, expect, it } from "vitest";
import { RunStateSchema, type RunState } from "@ai-sidekicks/contracts";

import type { ConsoleEntity } from "../../../console/store/index.js";
import { RUN_STATE_ADMITS_STEER, resolveAddressedRun, stateAdmitsSteer } from "./addressed-run.js";

const AGENT_ID = "agent-implementer";

function run(id: string, state: RunState, touchedAt: string): ConsoleEntity {
  return { kind: "run", id, state, touchedAt, body: { agentId: AGENT_ID, runVersion: 4 } };
}

function partition(...entities: readonly ConsoleEntity[]): Record<string, ConsoleEntity> {
  return Object.fromEntries(entities.map((entity) => [entity.id, entity]));
}

describe("RUN_STATE_ADMITS_STEER — total over the contract's own union", () => {
  it("keys only states the registered schema accepts", () => {
    // The `Record<RunState, boolean>` annotation makes a MISSING key a compile
    // error, so the half worth asserting at runtime is the other one: that no key
    // here is a state the wire does not carry, which a hand-written literal set
    // would let through until somebody read the daemon's reply beside it.
    for (const state of Object.keys(RUN_STATE_ADMITS_STEER)) {
      expect(RunStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it("admits exactly the six non-terminal states", () => {
    const admitted = Object.entries(RUN_STATE_ADMITS_STEER)
      .filter(([, admits]) => admits)
      .map(([state]) => state)
      .sort();
    expect(admitted).toStrictEqual([
      "paused",
      "queued",
      "running",
      "starting",
      "waiting_for_approval",
      "waiting_for_input",
    ]);
  });
});

describe("stateAdmitsSteer — the store's string, read through the registered schema", () => {
  it("refuses a state outside the union rather than reading it as live", () => {
    expect(stateAdmitsSteer("running")).toBe(true);
    expect(stateAdmitsSteer("cancelled")).toBe(false);
    expect(stateAdmitsSteer(undefined)).toBe(false);
  });
});

describe("resolveAddressedRun — the newest run that still admits a steer", () => {
  it("prefers an older active run over a terminal one touched later", () => {
    // This case IS the negative control for the superseded rule: "the newest run by
    // `touchedAt`, whatever its state" answers `run-settled` here, so the assertion
    // below fails on the code that shipped before the fix.
    const older = run("run-active", "running", "2026-01-01T10:00:00.000Z");
    const newer = run("run-settled", "completed", "2026-01-01T11:00:00.000Z");
    expect(resolveAddressedRun(partition(older, newer), AGENT_ID)?.id).toBe("run-active");
  });

  it("addresses no run at all when every run this agent has is terminal", () => {
    const partitions = partition(
      run("run-a", "completed", "2026-01-01T10:00:00.000Z"),
      run("run-b", "failed", "2026-01-01T11:00:00.000Z"),
      run("run-c", "interrupted", "2026-01-01T12:00:00.000Z"),
    );
    expect(resolveAddressedRun(partitions, AGENT_ID)).toBeUndefined();
  });

  it("takes the newest among several that all admit a steer", () => {
    const older = run("run-old", "running", "2026-01-01T10:00:00.000Z");
    const newer = run("run-new", "waiting_for_approval", "2026-01-01T12:00:00.000Z");
    expect(resolveAddressedRun(partition(older, newer), AGENT_ID)?.id).toBe("run-new");
  });

  it("ignores a live run bound to another agent", () => {
    const mine = run("run-mine", "paused", "2026-01-01T10:00:00.000Z");
    const theirs: ConsoleEntity = {
      kind: "run",
      id: "run-theirs",
      state: "running",
      touchedAt: "2026-01-01T13:00:00.000Z",
      body: { agentId: "agent-reviewer" },
    };
    expect(resolveAddressedRun(partition(mine, theirs), AGENT_ID)?.id).toBe("run-mine");
  });
});
