// The join that gives a run a driver, and the ways it refuses to invent one.
// `driver.listCapabilities` names no run, so the join is what binds gated controls to a driver;
// a run whose agent no row brings in, and a row naming another session, contribute nothing.

import { describe, expect, it } from "vitest";

import { definitionAgentQueuedBeat, leadCreatedBeat } from "./agent-entry-beats.test-support.js";
import { foldRunDriverBindings } from "./run-driver-bindings.js";
import type { StoredEntity } from "@renderer/store/session/entities/entities.js";

const SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55a5";
const OTHER_SESSION_ID = "019b7a33-3300-75e5-8510-ada11a5a55b6";
const LEAD_AGENT_ID = "019b7a33-3300-7a6e-8110-d1a4c1150301";
const OTHER_AGENT_ID = "019b7a33-3300-7a6e-8120-d1a4c1150302";
const DEFINITION_RUN_ID = "019b7a33-3300-740e-8120-d1a4c1150312";

function runBoundTo(runId: string, agentId: string | undefined): StoredEntity {
  return {
    kind: "run",
    id: runId,
    state: "running",
    ...(agentId === undefined ? {} : { body: { agentId, runVersion: 3 } }),
  };
}

function partitionOf(...runs: readonly StoredEntity[]): Readonly<Record<string, StoredEntity>> {
  return Object.fromEntries(runs.map((run) => [run.id, run]));
}

const CODEX_LEAD = leadCreatedBeat({
  sessionId: SESSION_ID,
  leadAgentId: LEAD_AGENT_ID,
  driverName: "codex",
});

describe("the run-to-driver join", () => {
  it("names a run's driver through the lead the session's birth record names", () => {
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", LEAD_AGENT_ID)), [
      CODEX_LEAD,
    ]);
    expect(bindings.get("run-one")).toBe("codex");
  });

  it("names a run's driver through the agent its creation started from a saved definition", () => {
    const bindings = foldRunDriverBindings(
      partitionOf(runBoundTo(DEFINITION_RUN_ID, OTHER_AGENT_ID)),
      [
        CODEX_LEAD,
        definitionAgentQueuedBeat({
          sessionId: SESSION_ID,
          runId: DEFINITION_RUN_ID,
          agentId: OTHER_AGENT_ID,
          leadAgentId: LEAD_AGENT_ID,
          driverName: "claude",
        }),
      ],
    );
    expect(bindings.get(DEFINITION_RUN_ID)).toBe("claude");
  });

  it("negative control: a run's creation naming another session binds nothing", () => {
    const strayBeat = definitionAgentQueuedBeat({
      sessionId: SESSION_ID,
      payloadSessionId: OTHER_SESSION_ID,
      runId: DEFINITION_RUN_ID,
      agentId: OTHER_AGENT_ID,
      leadAgentId: LEAD_AGENT_ID,
      driverName: "claude",
    });
    const bindings = foldRunDriverBindings(
      partitionOf(runBoundTo(DEFINITION_RUN_ID, OTHER_AGENT_ID)),
      [strayBeat],
    );
    expect(bindings.size).toBe(0);
  });

  it("names nothing for a run whose agent no row brings into the session", () => {
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", OTHER_AGENT_ID)), [
      CODEX_LEAD,
    ]);
    expect(bindings.has("run-one")).toBe(false);
  });

  it("names nothing for a run whose body names no agent", () => {
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", undefined)), [
      CODEX_LEAD,
    ]);
    expect(bindings.size).toBe(0);
  });

  it("negative control: a birth record naming another session binds nothing", () => {
    // A payload naming another session is a claim about another store.
    const strayBeat = leadCreatedBeat({
      sessionId: SESSION_ID,
      payloadSessionId: OTHER_SESSION_ID,
      leadAgentId: LEAD_AGENT_ID,
      driverName: "codex",
    });
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", LEAD_AGENT_ID)), [
      strayBeat,
    ]);
    expect(bindings.size).toBe(0);
  });

  it("negative control: a beat of another kind carrying a lead binds nothing", () => {
    // Without this, a fold that read a lead off any payload spelling one would pass the
    // cases above.
    const bindings = foldRunDriverBindings(partitionOf(runBoundTo("run-one", LEAD_AGENT_ID)), [
      { ...CODEX_LEAD, kind: "run.provider_initialized" },
    ]);
    expect(bindings.size).toBe(0);
  });
});
