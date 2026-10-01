// The `run` partition, driven by the real scenarios through the real store. Every scenario's run
// beats reach the partition through the shipped apply path with no degradation; the fold keeps
// what an earlier event named (`run.queued` alone carries `agentId`, so a wholesale replace would
// lose the agent on the next transition); and a beat whose state or session disagrees with its
// envelope writes nothing. The body's members are covered in
// `run-lifecycle-projector.body.test.ts`.

import { describe, expect, it } from "vitest";

import { RunQueuedPayloadSchema } from "@ai-sidekicks/contracts";

import { SCENARIOS } from "../../../../../fixtures/index.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { SYNTHETIC_SESSION_ID } from "./run-lifecycle-projector.test-support.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { SessionStore } from "../session/session-store.js";
import { type ProjectedSessionEvent } from "../session/entities/entities.js";
import { type SessionSnapshot } from "../session/session-state.js";
import {
  RUN_LIFECYCLE_EVENT_KINDS,
  RUN_LIFECYCLE_PROJECTORS,
  projectRunLifecycleEvent,
} from "./run-lifecycle-projector.js";

/** A base state current as of the beat before the scenario's first, so no gap is degraded. */
function baseStateFor(scenario: Scenario): SessionSnapshot {
  const sequences = scenario.beats.map((beat) => beat.event.sequence);
  return {
    cursor: Math.min(...sequences) - 1,
    entities: [],
  };
}

/** One store per scenario, projecting exactly what the composition root registers. */
function storeDrivenBy(scenario: Scenario): SessionStore {
  const store = new SessionStore({
    sessionId: scenario.sessionId,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialize(baseStateFor(scenario));
  store.applyBatch(scenario.beats.map((beat) => beat.event));
  return store;
}

/** The run ids the scenario's own beats name, in beat order and without repeats. */
function runIdsNamedBy(scenario: Scenario): readonly string[] {
  const runIds: string[] = [];
  for (const beat of scenario.beats) {
    if (!RUN_LIFECYCLE_EVENT_KINDS.includes(beat.event.kind)) {
      continue;
    }
    const runId = beat.event.payload?.["runId"];
    if (typeof runId === "string" && !runIds.includes(runId)) {
      runIds.push(runId);
    }
  }
  return runIds;
}

/** The first beat of one kind, or a failure naming what the scenario was missing. */
function firstBeatOfKind(scenario: Scenario, kind: string): ProjectedSessionEvent {
  const beat = scenario.beats.find((candidate) => candidate.event.kind === kind);
  if (beat === undefined) {
    throw new Error(`scenario "${scenario.id}" scripts no ${kind} beat`);
  }
  return beat.event;
}

describe("the run partition under every shipped scenario", () => {
  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: every run its beats name reaches the run partition, and nothing else does",
    (_scenarioId, scenario) => {
      const store = storeDrivenBy(scenario);
      const state = store.snapshot();

      expect(Object.keys(state.partitions.run).sort()).toStrictEqual(
        [...runIdsNamedBy(scenario)].sort(),
      );
      // A projector throw, a gap or a divergence would each degrade the store.
      expect(state.degradedCause).toBeUndefined();
      expect(state.timeline.length).toBe(scenario.beats.length);
    },
  );
});

describe("the concurrent-streaming scenario's run, folded", () => {
  const concurrentStreaming = CONCURRENT_STREAMING_SCENARIO;

  it("keeps the agent the queued beat named across the next transition", () => {
    const queued = firstBeatOfKind(concurrentStreaming, "run.queued");
    const runId = queued.payload?.["runId"];
    expect(typeof runId).toBe("string");

    // The last transition of that run, read from the script: the scenario streams for many
    // beats after `run.starting`, so naming that kind would test the script's length.
    const lastTransition = concurrentStreaming.beats
      .map((beat) => beat.event)
      .filter((event) => event.payload?.["runId"] === runId && event.kind.startsWith("run."))
      .at(-1);
    expect(lastTransition).toBeDefined();
    if (lastTransition === undefined) {
      throw new Error("unreachable: the assertion above fails first");
    }
    expect(lastTransition.sequence).toBeGreaterThan(queued.sequence);

    const run = storeDrivenBy(concurrentStreaming).snapshot().partitions.run[String(runId)];

    // The body keeps the agent only the first beat named; that beat names an agent already in
    // the session or one it starts from a definition.
    const creation = RunQueuedPayloadSchema.parse(queued.payload);
    const queuedAgentId = creation.agentId ?? creation.resolvedAgent?.agentId;
    expect(queuedAgentId).toBeDefined();
    expect(run?.state).toBe(lastTransition.payload?.["newState"]);
    expect(run?.body?.["previousState"]).toBe(lastTransition.payload?.["previousState"]);
    expect(run?.body?.["runVersion"]).toBe(lastTransition.payload?.["runVersion"]);
    expect(run?.body?.["agentId"]).toBe(queuedAgentId);
    expect(run?.touchedAt).toBe(lastTransition.occurredAt);
  });
});

/**
 * One synthetic run beat, for payloads no scenario scripts. The payload is supplied whole, since
 * the cases are about a member the beat does not carry.
 */
function runBeat(kind: string, payload: Readonly<Record<string, unknown>>): ProjectedSessionEvent {
  return {
    id: "019b79ee-0280-7ea1-8110-e5e0d1150804",
    sessionId: SYNTHETIC_SESSION_ID,
    sequence: 1,
    kind,
    occurredAt: "2026-01-01T14:20:00.500Z",
    payload,
  };
}

/**
 * The beats a store sees, applied through the shipped chokepoint with only this projector
 * registered. Sequence 1 against cursor 0 reads as the next event, not a gap.
 */
function storeApplying(events: readonly ProjectedSessionEvent[]): SessionStore {
  const store = new SessionStore({
    sessionId: SYNTHETIC_SESSION_ID,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialize({ cursor: 0, entities: [] });
  store.applyBatch([...events]);
  return store;
}

describe("the projector on a payload that does not carry its kind's state", () => {
  /** A well-formed durable run payload, before a case spoils one member of it. */
  function payloadNaming(newState: unknown): Readonly<Record<string, unknown>> {
    return { sessionId: SYNTHETIC_SESSION_ID, runId: "run-1", runVersion: 5, newState };
  }

  it("answers with no mutation when the payload names a state the kind does not", () => {
    // Nothing above the fold rejects a beat reporting two states. Storing the payload's reading
    // would show a failed run under a kind the transcript renders as running.
    expect(projectRunLifecycleEvent(runBeat("run.running", payloadNaming("failed")))).toStrictEqual(
      [],
    );
  });

  it("leaves the run exactly as it was for a transition beat naming no state", () => {
    // Upserting a stateless `run.running` would advance `touchedAt` and land its body members
    // while the state stayed `starting`; the beat must contribute nothing.
    const starting = runBeat("run.starting", payloadNaming("starting"));
    const statelessRunning: ProjectedSessionEvent = {
      ...runBeat("run.running", {
        sessionId: SYNTHETIC_SESSION_ID,
        runId: "run-1",
        runVersion: 6,
        trigger: "step_limit",
      }),
      sequence: 2,
      occurredAt: "2026-01-01T14:20:00.900Z",
    };

    const store = storeApplying([starting, statelessRunning]);
    const run = store.snapshot().partitions.run["run-1"];

    expect(run?.state).toBe("starting");
    expect(run?.touchedAt).toBe(starting.occurredAt);
    expect(run?.body?.["runVersion"]).toBe(5);
    expect(run?.body?.["trigger"]).toBeUndefined();
  });
});

describe("the projector on a payload that names another session", () => {
  const OTHER_SESSION_ID = "019b79ee-0280-75e5-8510-b0b0b0b0b0b0";

  it("answers with no mutation when the payload names a different session", () => {
    // The envelope schema admits the payload whole, so a beat for session B on session A's
    // subscription arrives well-formed and would write B's run into A's partition.
    expect(
      projectRunLifecycleEvent(
        runBeat("run.running", {
          sessionId: OTHER_SESSION_ID,
          runId: "run-1",
          runVersion: 5,
          newState: "running",
        }),
      ),
    ).toStrictEqual([]);
  });
});
