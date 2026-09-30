// A composer left on a settled run keeps every message on the steer path, and the daemon refuses
// each one, so the new-turn path is unreachable for the rest of the session.

import { describe, expect, it } from "vitest";
import type { RunState } from "@ai-sidekicks/contracts";

import type { StoredEntity } from "@renderer/store/session/entities/entities.js";
import { RUN_STATE_ADMITS_STEER, resolveAddressedRun, stateAdmitsSteer } from "./addressed-run.js";

const AGENT_ID = "agent-implementer";

/** Every state the wire carries; `satisfies` makes a state the wire lacks fail `typecheck`. */
const WIRE_RUN_STATES = [
  "queued",
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "pausing",
  "paused",
  "completed",
  "interrupted",
  "failed",
] as const satisfies readonly RunState[];

function run(id: string, state: RunState, touchedAt: string): StoredEntity {
  return { kind: "run", id, state, touchedAt, body: { agentId: AGENT_ID, runVersion: 4 } };
}

function partition(...entities: readonly StoredEntity[]): Record<string, StoredEntity> {
  return Object.fromEntries(entities.map((entity) => [entity.id, entity]));
}

describe("RUN_STATE_ADMITS_STEER — total over the contract's own union", () => {
  it("keys exactly the states the wire carries", () => {
    // The `Record` annotation already rejects a missing key; this asserts no key is a state the
    // wire does not carry.
    expect(Object.keys(RUN_STATE_ADMITS_STEER).sort()).toStrictEqual([...WIRE_RUN_STATES].sort());
  });

  it("admits exactly the seven non-terminal states", () => {
    const admitted = Object.entries(RUN_STATE_ADMITS_STEER)
      .filter(([, admits]) => admits)
      .map(([state]) => state)
      .sort();
    expect(admitted).toStrictEqual([
      "paused",
      "pausing",
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
    expect(stateAdmitsSteer("canceled")).toBe(false);
    expect(stateAdmitsSteer(undefined)).toBe(false);
  });
});

describe("resolveAddressedRun — the newest run that still admits a steer", () => {
  it("prefers an older active run over a terminal one touched later", () => {
    // Negative control: "newest run by `touchedAt`, whatever its state" answers `run-settled`
    // here.
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
    const theirs: StoredEntity = {
      kind: "run",
      id: "run-theirs",
      state: "running",
      touchedAt: "2026-01-01T13:00:00.000Z",
      body: { agentId: "agent-reviewer" },
    };
    expect(resolveAddressedRun(partition(mine, theirs), AGENT_ID)?.id).toBe("run-mine");
  });
});
