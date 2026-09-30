// The `run` partition, driven by the real scenarios through the real store. Three claims:
// the kinds it claims are the taxonomy's `run_lifecycle` category; every scenario's run beats
// reach the partition through the shipped apply path with no degradation; and the fold keeps
// what an earlier event named (`run.queued` alone carries `agentId`, so a wholesale replace
// would lose the agent on the next transition). The body's members are covered in
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

describe("the run-lifecycle projector's claimed kinds", () => {
  it("claims exactly the taxonomy's run_lifecycle category", () => {
    // A divergence would mean the fan-out dropped a kind.
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
    // `run.started` looks real and is not; the others belong to other categories.
    for (const kind of [
      "run.started",
      "agent.provider_binding_changed",
      "usage.token_count",
      "session.created",
    ]) {
      expect(RUN_LIFECYCLE_EVENT_KINDS).not.toContain(kind);
      expect(Object.hasOwn(RUN_LIFECYCLE_PROJECTORS, kind)).toBe(false);
    }
  });
});

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

  it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))(
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

describe("the concurrent-streaming scenario's run, folded", () => {
  const concurrentStreaming = CONCURRENT_STREAMING_SCENARIO;

  it("stamps the run into the store from its creation beat, with no state it came from", () => {
    // The creation names the state the run is in and no state it came from. The fold is the
    // only way a view learns the run exists, since `run.subscribeState` omits the creation.
    const queued = firstBeatOfKind(concurrentStreaming, "run.queued");
    const beforeAnyTransition = {
      ...concurrentStreaming,
      beats: concurrentStreaming.beats.filter((beat) => beat.event.sequence <= queued.sequence),
    };

    const run =
      storeDrivenBy(beforeAnyTransition).snapshot().partitions.run[
        String(queued.payload?.["runId"])
      ];

    expect(run?.state).toBe("queued");
    expect(run?.body?.["previousState"]).toBeUndefined();
    expect(run?.touchedAt).toBe(queued.occurredAt);
  });

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

  it("attributes a run to the user the envelope names, and only then", () => {
    const queued = firstBeatOfKind(concurrentStreaming, "run.queued");
    const starting = firstBeatOfKind(concurrentStreaming, "run.starting");
    // The daemon-driven transition carries no actor, so the first attribution must survive.
    expect(queued.actorId).toBeDefined();
    expect(starting.actorId).toBeUndefined();

    const run =
      storeDrivenBy(concurrentStreaming).snapshot().partitions.run[
        String(queued.payload?.["runId"])
      ];

    expect(run?.attributedTo).toBe(queued.actorId);
  });
});

/**
 * One synthetic run beat, for payloads no scenario scripts. The payload is supplied whole, since
 * many cases are about a member the beat does not carry.
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
function storeApplying(events: readonly ProjectedSessionEvent[]): {
  readonly store: SessionStore;
  readonly outcome: ReturnType<SessionStore["applyBatch"]>;
} {
  const store = new SessionStore({
    sessionId: SYNTHETIC_SESSION_ID,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialize({ cursor: 0, entities: [] });
  return { store, outcome: store.applyBatch([...events]) };
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

  it("answers with no mutation when a recognized transition names no state at all", () => {
    // The quiet half: accepting absence would keep the last transition's state, so the timeline
    // reads `run.running` while the partition still reads `starting`. Refuse, never default.
    expect(
      projectRunLifecycleEvent(
        runBeat("run.running", { sessionId: SYNTHETIC_SESSION_ID, runId: "run-1", runVersion: 5 }),
      ),
    ).toStrictEqual([]);
  });

  it("answers with no mutation when a recognized transition's state is not a string", () => {
    // A wrong-typed member reaches the guard as absence; a tolerant wire really sends these.
    for (const spoiled of [7, null, ["running"], { state: "running" }, ""]) {
      expect(
        projectRunLifecycleEvent(runBeat("run.running", payloadNaming(spoiled))),
      ).toStrictEqual([]);
    }
  });

  it("projects the same beat when the state and the kind agree", () => {
    // Keeps the cases above from holding over a projector that refused every run beat.
    const mutations = projectRunLifecycleEvent(runBeat("run.running", payloadNaming("running")));

    expect(mutations).toHaveLength(1);
    const [mutation] = mutations;
    if (mutation?.operation !== "upsert") {
      throw new Error("the projector answered no upsert for an agreeing beat");
    }
    expect(mutation.entity.state).toBe("running");
  });

  it("leaves the store undegraded — the refused beat is still admitted", () => {
    // Omission, not a raise: the projector is pure and replayed, and the timeline records it.
    const { store, outcome } = storeApplying([runBeat("run.running", payloadNaming("failed"))]);

    expect(outcome.admitted).toBe(1);
    expect(outcome.projectionFailures).toBe(0);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    expect(store.snapshot().timeline.length).toBe(1);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });

  it("negative control: the stateless beat leaves the run exactly as it was", () => {
    // Upserting a stateless `run.running` would advance `touchedAt` and land its body members
    // while the state stayed `starting`; the beat must contribute nothing.
    const starting = runBeat("run.starting", payloadNaming("starting"));
    const statelessRunning: ProjectedSessionEvent = {
      ...runBeat("run.running", {
        sessionId: SYNTHETIC_SESSION_ID,
        runId: "run-1",
        runVersion: 6,
        trigger: "idle_timeout",
      }),
      sequence: 2,
      occurredAt: "2026-01-01T14:20:00.900Z",
    };

    const { store } = storeApplying([starting, statelessRunning]);
    const run = store.snapshot().partitions.run["run-1"];

    expect(run?.state).toBe("starting");
    expect(run?.touchedAt).toBe(starting.occurredAt);
    expect(run?.body?.["runVersion"]).toBe(5);
    expect(run?.body?.["trigger"]).toBeUndefined();
  });

  it("keeps the creation row, which announces a state by a kind no transition carries", () => {
    // `run.queued` announces no state in the mapping the guard reads; refusing it would drop the
    // only beat that tells a view the run exists.
    expect(projectRunLifecycleEvent(runBeat("run.queued", payloadNaming("queued")))).toHaveLength(
      1,
    );
  });

  it("keeps the forward, non-state rows, which announce no transition either", () => {
    // The forward, non-state rows announce no transition either, so demanding a `newState` of
    // them would refuse every one.
    expect(
      projectRunLifecycleEvent(
        runBeat("run.rolled_back", {
          sessionId: SYNTHETIC_SESSION_ID,
          runId: "run-1",
          targetPosition: 12,
        }),
      ),
    ).toHaveLength(1);
    expect(
      projectRunLifecycleEvent(
        runBeat("run.turn_started", {
          sessionId: SYNTHETIC_SESSION_ID,
          runId: "run-1",
          position: 17,
        }),
      ),
    ).toHaveLength(1);
  });
});

describe("the projector on a payload that names another session", () => {
  const OTHER_SESSION_ID = "019b79ee-0280-75e5-8510-b0b0b0b0b0b0";

  it("answers with no mutation when the payload names no session", () => {
    // `sessionId` is registered on the durable row, so a beat without one is malformed and would
    // key a run into whichever store the envelope was routed to.
    expect(
      projectRunLifecycleEvent(
        runBeat("run.running", { runId: "run-1", runVersion: 5, newState: "running" }),
      ),
    ).toStrictEqual([]);
  });

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

  it("answers with no mutation when the payload's session is not a string", () => {
    // Compared against the raw member, so a non-string cannot read as absence and pass.
    for (const spoiled of [7, null, [SYNTHETIC_SESSION_ID], { id: SYNTHETIC_SESSION_ID }]) {
      expect(
        projectRunLifecycleEvent(
          runBeat("run.running", {
            sessionId: spoiled,
            runId: "run-1",
            runVersion: 5,
            newState: "running",
          }),
        ),
      ).toStrictEqual([]);
    }
  });

  it("projects the beat whose payload names the envelope's own session", () => {
    // Keeps the cases above from holding over a projector that refused everything.
    expect(
      projectRunLifecycleEvent(
        runBeat("run.running", {
          sessionId: SYNTHETIC_SESSION_ID,
          runId: "run-1",
          runVersion: 5,
          newState: "running",
        }),
      ),
    ).toHaveLength(1);
  });

  it("leaves the store undegraded — the foreign beat is admitted and never keyed", () => {
    const { store, outcome } = storeApplying([
      runBeat("run.running", {
        sessionId: OTHER_SESSION_ID,
        runId: "run-1",
        runVersion: 5,
        newState: "running",
      }),
    ]);

    expect(outcome.admitted).toBe(1);
    expect(outcome.projectionFailures).toBe(0);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    expect(store.snapshot().timeline.length).toBe(1);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });
});

describe("the projector on a payload it cannot key on", () => {
  const eventWithoutRunIdentity: ProjectedSessionEvent = {
    id: "019b79ee-0280-7ea1-8110-e5e0d1150801",
    sessionId: SYNTHETIC_SESSION_ID,
    sequence: 1,
    kind: "run.starting",
    occurredAt: "2026-01-01T14:20:00.400Z",
    payload: { sessionId: SYNTHETIC_SESSION_ID, newState: "starting" },
  };

  it("answers with no mutation rather than throwing", () => {
    expect(projectRunLifecycleEvent(eventWithoutRunIdentity)).toStrictEqual([]);
  });

  it("leaves the store undegraded — the event is admitted and the timeline records it", () => {
    const { store, outcome } = storeApplying([eventWithoutRunIdentity]);

    expect(outcome.admitted).toBe(1);
    expect(outcome.projectionFailures).toBe(0);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    expect(store.snapshot().degradedCause).toBeUndefined();
  });

  it("reads a wrong-typed member as absent rather than rendering it", () => {
    // A turn boundary announces no state, so this exercises the reader, not the state guard: a
    // spoiled `newState` is absence, not a refusal.
    const mutations = projectRunLifecycleEvent(
      runBeat("run.turn_started", {
        sessionId: SYNTHETIC_SESSION_ID,
        runId: "run-1",
        newState: 7,
        runVersion: "2",
      }),
    );

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
