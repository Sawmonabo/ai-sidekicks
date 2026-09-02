// The `run` partition, driven by the real scenarios through the real store.
//
// Three claims, and each one failed before this projector existed:
//
//   • The kinds it claims ARE the taxonomy's `run_lifecycle` category — not a
//     list written beside it that a fourteenth run event would silently leave out.
//   • Every scenario's run beats reach the `run` partition through the shipped
//     apply chokepoint, with no store degraded and no projection failure. Real
//     scenarios and a real `SessionStore`: a local stand-in for either would be
//     checking this file's own copy of the thing under test.
//   • The fold KEEPS what an earlier event named. `run.queued` is the only kind
//     that carries `agentId`, so a fold that replaced the body wholesale would
//     lose the agent on the very next transition — visible to nobody, because a
//     run with no agent renders exactly like a run that never had one.

import { describe, expect, it } from "vitest";

import { CONSOLE_SCENARIOS } from "../bridge/scenarios/index.js";
import type { ConsoleScenario } from "../bridge/scenario.js";
import { SessionStore, type ConsoleSessionEvent, type SessionSnapshot } from "../store/index.js";
import {
  RUN_LIFECYCLE_EVENT_KINDS,
  RUN_LIFECYCLE_PROJECTORS,
  projectRunLifecycleEvent,
} from "./run-lifecycle-projector.js";

/**
 * A base state current as of the beat just before the scenario's first.
 *
 * Derived from the beats rather than pinned at `-1`: a store treats the distance
 * from its cursor to an event as a gap, so a base state that predates a scenario
 * starting at sequence 1 would degrade every store here for a hole the scenario
 * never had.
 */
function baseStateFor(scenario: ConsoleScenario): SessionSnapshot {
  const sequences = scenario.beats.map((beat) => beat.event.sequence);
  return {
    cursor: Math.min(...sequences) - 1,
    entities: [],
    participantJoinLog: [...scenario.participantIdsInJoinOrder],
  };
}

/** One store per scenario, projecting exactly what the composition root registers. */
function storeDrivenBy(scenario: ConsoleScenario): SessionStore {
  const store = new SessionStore({
    sessionId: scenario.sessionId,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialise(baseStateFor(scenario));
  store.applyBatch(scenario.beats.map((beat) => beat.event));
  return store;
}

/** The run ids the scenario's own beats name, in beat order and without repeats. */
function runIdsNamedBy(scenario: ConsoleScenario): readonly string[] {
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
function firstBeatOfKind(scenario: ConsoleScenario, kind: string): ConsoleSessionEvent {
  const beat = scenario.beats.find((candidate) => candidate.event.kind === kind);
  if (beat === undefined) {
    throw new Error(`scenario "${scenario.id}" scripts no ${kind} beat`);
  }
  return beat.event;
}

describe("the run-lifecycle projector's claimed kinds", () => {
  it("claims exactly the taxonomy's run_lifecycle category", () => {
    // The registry's keys and the derived list are two views of one set; a
    // divergence would mean the build step that fans the fold out dropped a kind.
    expect(Object.keys(RUN_LIFECYCLE_PROJECTORS).sort()).toStrictEqual(
      [...RUN_LIFECYCLE_EVENT_KINDS].sort(),
    );
    expect(RUN_LIFECYCLE_EVENT_KINDS.length).toBeGreaterThan(0);
  });

  it("claims the registered state transitions and the forward, non-state kinds", () => {
    for (const kind of [
      "run.queued",
      "run.starting",
      "run.running",
      "run.completed",
      "run.failed",
      "run.rolled_back",
      "run.turn_started",
    ]) {
      expect(RUN_LIFECYCLE_EVENT_KINDS).toContain(kind);
    }
  });

  it("claims no kind outside the category — the control a hand list would fail", () => {
    // `run.started` reads exactly like a real event and is not one; `agent.attached`
    // and `usage.token_count` are real and belong to other categories entirely. A
    // projector claiming any of them would be folding events it cannot read.
    for (const kind of ["run.started", "agent.attached", "usage.token_count", "session.created"]) {
      expect(RUN_LIFECYCLE_EVENT_KINDS).not.toContain(kind);
      expect(Object.hasOwn(RUN_LIFECYCLE_PROJECTORS, kind)).toBe(false);
    }
  });
});

describe("the run partition under every shipped scenario", () => {
  it.each(CONSOLE_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: every run its beats name reaches the run partition, and nothing else does",
    (_scenarioId, scenario) => {
      const store = storeDrivenBy(scenario);
      const state = store.snapshot();

      expect(Object.keys(state.partitions.run).sort()).toStrictEqual(
        [...runIdsNamedBy(scenario)].sort(),
      );
      // A projection failure is a projector that threw, which this one may not do,
      // and a gap or a divergence would mean the beats did not reach the fold at all.
      expect(state.degradedCause).toBeUndefined();
      expect(state.timeline.length).toBe(scenario.beats.length);
    },
  );

  it.each(CONSOLE_SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
    "%s: every projected run carries a wire-verbatim touch time",
    (_scenarioId, scenario) => {
      const store = storeDrivenBy(scenario);
      const occurredAtValues = new Set(scenario.beats.map((beat) => beat.event.occurredAt));

      for (const run of Object.values(store.snapshot().partitions.run)) {
        expect(run.kind).toBe("run");
        expect(occurredAtValues.has(run.touchedAt ?? "")).toBe(true);
      }
    },
  );
});

describe("the flagship scenario's run, folded", () => {
  const flagship = CONSOLE_SCENARIOS.find((scenario) => scenario.id === "flagship");

  it("keeps the agent the queued beat named across the next transition", () => {
    if (flagship === undefined) {
      throw new Error("the flagship scenario is not on the scenario board");
    }
    const queued = firstBeatOfKind(flagship, "run.queued");
    const starting = firstBeatOfKind(flagship, "run.starting");
    const runId = queued.payload?.["runId"];
    expect(typeof runId).toBe("string");

    const run = storeDrivenBy(flagship).snapshot().partitions.run[String(runId)];

    // The state is the LAST transition's `newState`, and the body still carries the
    // agent only the first beat named — the property the entity merge exists for.
    expect(run?.state).toBe(starting.payload?.["newState"]);
    expect(run?.body?.["previousState"]).toBe(starting.payload?.["previousState"]);
    expect(run?.body?.["runVersion"]).toBe(starting.payload?.["runVersion"]);
    expect(run?.body?.["agentId"]).toBe(queued.payload?.["agentId"]);
    expect(run?.touchedAt).toBe(starting.occurredAt);
  });

  it("attributes a run to the participant the envelope names, and only then", () => {
    if (flagship === undefined) {
      throw new Error("the flagship scenario is not on the scenario board");
    }
    const queued = firstBeatOfKind(flagship, "run.queued");
    const starting = firstBeatOfKind(flagship, "run.starting");
    // The queued beat carries an actor and the daemon-driven transition does not,
    // so the attribution the first established survives rather than being erased.
    expect(queued.actorParticipantId).toBeDefined();
    expect(starting.actorParticipantId).toBeUndefined();

    const run =
      storeDrivenBy(flagship).snapshot().partitions.run[String(queued.payload?.["runId"])];

    expect(run?.attributedTo).toBe(queued.actorParticipantId);
  });
});

describe("the projector on a payload it cannot key on", () => {
  const eventWithoutRunIdentity: ConsoleSessionEvent = {
    id: "019b79ee-0280-7ea1-8110-e5e0d1150801",
    sessionId: "019b79ee-0280-75e5-8510-ada11a5a11a5",
    sequence: 1,
    kind: "run.starting",
    occurredAt: "2026-01-01T14:20:00.400Z",
    payload: { newState: "starting" },
  };

  it("answers with no mutation rather than throwing", () => {
    expect(projectRunLifecycleEvent(eventWithoutRunIdentity)).toStrictEqual([]);
  });

  it("leaves the store undegraded — the event is admitted and the timeline records it", () => {
    const store = new SessionStore({
      sessionId: eventWithoutRunIdentity.sessionId,
      projectors: RUN_LIFECYCLE_PROJECTORS,
    });
    store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });

    const outcome = store.applyBatch([eventWithoutRunIdentity]);

    expect(outcome.admitted).toBe(1);
    expect(outcome.projectionFailures).toBe(0);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    expect(store.snapshot().degradedCause).toBeUndefined();
  });

  it("reads a wrong-typed member as absent rather than rendering it", () => {
    const mutations = projectRunLifecycleEvent({
      ...eventWithoutRunIdentity,
      payload: { runId: "run-1", newState: 7, runVersion: "2" },
    });

    expect(mutations).toHaveLength(1);
    const [mutation] = mutations;
    expect(mutation?.operation).toBe("upsert");
    if (mutation?.operation !== "upsert") {
      throw new Error("the projector answered with a removal");
    }
    expect(mutation.entity.state).toBeUndefined();
    expect(mutation.entity.body).toBeUndefined();
  });
});
