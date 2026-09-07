// The join that gives a run a driver, and the two ways it refuses to invent one.
//
// The claim worth a unit is the one the node-scoped capability read cannot make:
// `driver.listCapabilities` names no run, so on a machine with both drivers
// installed every run's gated controls depended on this join existing. The negative
// controls are the two halves that must contribute nothing rather than a default — a
// run whose agent nothing attached, and an attach beat that names another session.

import { describe, expect, it } from "vitest";

import { foldRunDriverBindings } from "./run-driver-binding.js";
import type { ConsoleEntity, ConsoleSessionEvent } from "../../store/index.js";

const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";
const OTHER_SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55b6";

/** One `agent.attached` beat, spelled as the taxonomy registers its persona. */
function agentAttached(
  sequence: number,
  agentId: string,
  driverName: string,
  sessionId = SESSION_ID,
): ConsoleSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    kind: "agent.attached",
    occurredAt: "2026-01-01T00:00:00.000Z",
    payload: {
      sessionId,
      agentId,
      name: "Ada",
      driverName,
      modelId: "a-model",
      state: "ready",
    },
  };
}

/** One run row as the run partition holds it, with the agent its creation named. */
function runBoundTo(runId: string, agentId: string | undefined): ConsoleEntity {
  return {
    kind: "run",
    id: runId,
    state: "running",
    ...(agentId === undefined ? {} : { body: { agentId, runVersion: 3 } }),
  };
}

function partitionOf(...runs: readonly ConsoleEntity[]): Readonly<Record<string, ConsoleEntity>> {
  return Object.fromEntries(runs.map((run) => [run.id, run]));
}

describe("the run-to-driver join", () => {
  it("names each run's driver through the agent its creation named", () => {
    const bindings = foldRunDriverBindings(
      partitionOf(runBoundTo("run-one", "agent-claude"), runBoundTo("run-two", "agent-codex")),
      [agentAttached(1, "agent-claude", "claude"), agentAttached(2, "agent-codex", "codex")],
    );
    expect(bindings.get("run-one")).toBe("claude");
    expect(bindings.get("run-two")).toBe("codex");
  });

  it("reads the newest attach beat for an agent, not the first", () => {
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", "agent-one")), [
      agentAttached(1, "agent-one", "claude"),
      agentAttached(2, "agent-one", "codex"),
    ]);
    expect(bindings.get("run-one")).toBe("codex");
  });

  it("names nothing for a run whose agent no attach beat named", () => {
    const bindings = foldRunDriverBindings(
      partitionOf(runBoundTo("run-one", "agent-nobody-attached")),
      [agentAttached(1, "agent-other", "claude")],
    );
    expect(bindings.has("run-one")).toBe(false);
  });

  it("names nothing for a run whose body names no agent", () => {
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", undefined)), [
      agentAttached(1, "agent-one", "claude"),
    ]);
    expect(bindings.size).toBe(0);
  });

  it("negative control: an attach beat naming another session binds nothing", () => {
    // A payload naming another session is a claim about another store. Reading it
    // here would bind this session's run to a driver named somewhere else.
    const strayBeat: ConsoleSessionEvent = {
      ...agentAttached(1, "agent-one", "codex", OTHER_SESSION_ID),
      sessionId: SESSION_ID,
    };
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", "agent-one")), [
      strayBeat,
    ]);
    expect(bindings.size).toBe(0);
  });

  it("negative control: a beat of another kind carrying a driver name binds nothing", () => {
    // Without this, a fold that read `driverName` off any payload that happened to
    // spell it would pass every case above.
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", "agent-one")), [
      {
        id: "event-1",
        sessionId: SESSION_ID,
        sequence: 1,
        kind: "run.provider_initialized",
        occurredAt: "2026-01-01T00:00:00.000Z",
        payload: { sessionId: SESSION_ID, agentId: "agent-one", driverName: "claude" },
      },
    ]);
    expect(bindings.size).toBe(0);
  });
});
