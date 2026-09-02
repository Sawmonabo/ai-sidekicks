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
//
// The fourth claim — that the body carries the members the wire shapes register
// rather than four of them — is its own subject and lives beside this one, in
// `run-lifecycle-projector.body.test.ts`.

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

  it("stamps the run into the store from its creation beat, with no state it came from", () => {
    // The creation beat is not a transition, so it names the state the run is IN and
    // no state it came from — `queued` is the destination of no row in the run state
    // machine's transition table. The run still has to reach the store from it,
    // because `run.subscribeState` does not carry the creation kind at all: this
    // fold is the only way a surface learns the run exists.
    if (flagship === undefined) {
      throw new Error("the flagship scenario is not on the scenario board");
    }
    const queued = firstBeatOfKind(flagship, "run.queued");
    const beforeAnyTransition = {
      ...flagship,
      beats: flagship.beats.filter((beat) => beat.event.sequence <= queued.sequence),
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
    expect(queued.actorId).toBeDefined();
    expect(starting.actorId).toBeUndefined();

    const run =
      storeDrivenBy(flagship).snapshot().partitions.run[String(queued.payload?.["runId"])];

    expect(run?.attributedTo).toBe(queued.actorId);
  });
});

/** The session every synthetic beat below is delivered on. */
const SYNTHETIC_SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a11a5";

/**
 * One synthetic run beat, so a case can drive a payload no scenario scripts.
 *
 * The payload is supplied WHOLE rather than assembled from named arguments,
 * because half the cases below are about a member the beat does not carry and a
 * builder that always wrote one could not express them.
 */
function runBeat(kind: string, payload: Readonly<Record<string, unknown>>): ConsoleSessionEvent {
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
 * The beats a store sees, applied through the shipped chokepoint with only this
 * projector registered.
 *
 * Sequence 1 against a cursor of 0, so the store reads the first beat as the next
 * event rather than as a gap it would degrade for.
 */
function storeApplying(events: readonly ConsoleSessionEvent[]): {
  readonly store: SessionStore;
  readonly outcome: ReturnType<SessionStore["applyBatch"]>;
} {
  const store = new SessionStore({
    sessionId: SYNTHETIC_SESSION_ID,
    projectors: RUN_LIFECYCLE_PROJECTORS,
  });
  store.initialise({ cursor: 0, entities: [], participantJoinLog: [] });
  return { store, outcome: store.applyBatch([...events]) };
}

describe("the projector on a payload that does not carry its kind's state", () => {
  /** A well-formed durable run payload, before a case spoils one member of it. */
  function payloadNaming(newState: unknown): Readonly<Record<string, unknown>> {
    return { sessionId: SYNTHETIC_SESSION_ID, runId: "run-1", runVersion: 5, newState };
  }

  it("answers with no mutation when the payload names a state the kind does not", () => {
    // The beat reports two states at once and nothing above the fold rejects it:
    // no run-lifecycle payload variant is registered, so the strict layer never
    // sees the pair. Storing the payload's reading would put a failed run under a
    // kind the timeline renders as running — one event, two surfaces, two answers.
    expect(projectRunLifecycleEvent(runBeat("run.running", payloadNaming("failed")))).toStrictEqual(
      [],
    );
  });

  it("answers with no mutation when a recognized transition names no state at all", () => {
    // The quiet half of the same defect. The fold used to accept absence, upsert
    // the run, and PRESERVE whatever state the last transition established — so
    // the timeline read `run.running` while the partition still read `starting`.
    // A recognized kind must supply the state it announces; refuse, never default.
    expect(
      projectRunLifecycleEvent(
        runBeat("run.running", { sessionId: SYNTHETIC_SESSION_ID, runId: "run-1", runVersion: 5 }),
      ),
    ).toStrictEqual([]);
  });

  it("answers with no mutation when a recognized transition's state is not a string", () => {
    // A wrong-typed member reaches the guard as absence, so this is the case above
    // arriving by the other road — and it is the road a tolerant wire actually
    // takes, since the envelope schema admits any payload shape.
    for (const spoiled of [7, null, ["running"], { state: "running" }, ""]) {
      expect(
        projectRunLifecycleEvent(runBeat("run.running", payloadNaming(spoiled))),
      ).toStrictEqual([]);
    }
  });

  it("projects the same beat when the state and the kind agree", () => {
    // The control that keeps the cases above from holding over a projector that
    // refused every run beat.
    const mutations = projectRunLifecycleEvent(runBeat("run.running", payloadNaming("running")));

    expect(mutations).toHaveLength(1);
    const [mutation] = mutations;
    if (mutation?.operation !== "upsert") {
      throw new Error("the projector answered no upsert for an agreeing beat");
    }
    expect(mutation.entity.state).toBe("running");
  });

  it("leaves the store undegraded — the refused beat is still admitted", () => {
    // Omission and not a raise, for the reason a payload with no `runId` is
    // omitted: the projector is pure and replayed, the event really did arrive,
    // and the timeline is the ledger that records it.
    const { store, outcome } = storeApplying([runBeat("run.running", payloadNaming("failed"))]);

    expect(outcome.admitted).toBe(1);
    expect(outcome.projectionFailures).toBe(0);
    expect(store.snapshot().partitions.run).toStrictEqual({});
    expect(store.snapshot().timeline.length).toBe(1);
    expect(store.snapshot().degradedCause).toBeUndefined();
  });

  it("negative control: the stateless beat leaves the run exactly as it was", () => {
    // What the tolerant reading did, stated as an observation rather than as a
    // claim about the code. A `run.running` beat carrying no readable state used
    // to upsert the run: the state stayed `starting` while `touchedAt` advanced to
    // the malformed beat and its body members landed — a run reported as freshly
    // touched, under a kind the timeline renders as running, still holding the
    // state it left. Now the second beat contributes nothing at all.
    const starting = runBeat("run.starting", payloadNaming("starting"));
    const statelessRunning: ConsoleSessionEvent = {
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
    // `run.queued` is the run's creation, and the mapping the guard reads claims
    // no state for it — deliberately, because it is the destination of no row in
    // the transition table. A guard that treated "the mapping answers nothing" as
    // a failure would drop the only beat that tells a surface the run exists.
    expect(projectRunLifecycleEvent(runBeat("run.queued", payloadNaming("queued")))).toHaveLength(
      1,
    );
  });

  it("keeps the forward, non-state rows, which announce no transition either", () => {
    // The same scope claim for the other three kinds the mapping answers nothing
    // for. A rollback names a target position and no state, and a turn boundary
    // names a position: demanding a `newState` of them would refuse every one.
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
    // `sessionId` is a registered member of the durable `run_lifecycle` row, so a
    // beat without one is malformed rather than terse — and the fold would key a
    // run into whichever store the envelope happened to be routed to.
    expect(
      projectRunLifecycleEvent(
        runBeat("run.running", { runId: "run-1", runVersion: 5, newState: "running" }),
      ),
    ).toStrictEqual([]);
  });

  it("answers with no mutation when the payload names a different session", () => {
    // The delivery this guard exists for: the envelope schema admits the payload
    // whole and the strict event union registers no run-lifecycle variant, so a
    // beat for session B arrives on session A's subscription well-formed and used
    // to write session B's run into session A's partition.
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
    // Compared against the raw member rather than a read one, so a non-string
    // cannot be read as absence and then be waved through by a laxer arm.
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
    // The control: the guard is checked once at the fold's entry for every kind in
    // the family, so a projector that refused everything would pass every case
    // above and this one names the difference.
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
  const eventWithoutRunIdentity: ConsoleSessionEvent = {
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
    // On a kind the transition mapping claims nothing for, so the reading under
    // test is the READER's and not the state guard's: a turn boundary announces no
    // state, so a spoiled `newState` there is absence and not a refusal.
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
