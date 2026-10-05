// A composer left on a settled run keeps every message on the steer path, and the daemon refuses
// each one, so the new-turn path is unreachable for the rest of the session.

import { describe, expect, it } from "vitest";
import type { RunState } from "@ai-sidekicks/contracts/run/state";

import type { StoredEntity } from "#renderer/store/session/entities/entities.js";
import { resolveAddressedRun } from "./addressed-run.js";

const AGENT_ID = "agent-implementer";

function run(id: string, state: RunState, touchedAt: string): StoredEntity {
  return { kind: "run", id, state, touchedAt, body: { agentId: AGENT_ID, runVersion: 4 } };
}

function partition(...entities: readonly StoredEntity[]): Record<string, StoredEntity> {
  return Object.fromEntries(entities.map((entity) => [entity.id, entity]));
}

describe("resolveAddressedRun — the newest run that still admits a steer", () => {
  it("prefers an older active run over a terminal one touched later", () => {
    // Negative control: "newest run by `touchedAt`, whatever its state" answers `run-settled`
    // here.
    const older = run("run-active", "running", "2026-01-01T10:00:00.000Z");
    const newer = run("run-settled", "completed", "2026-01-01T11:00:00.000Z");
    expect(resolveAddressedRun(partition(older, newer), AGENT_ID)?.id).toBe("run-active");
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
