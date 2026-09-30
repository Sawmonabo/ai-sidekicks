// Every beat reaches a subscriber exactly once, whatever order the script is in. The engine's
// count and the set it has delivered are one claim, and both halves are asserted against the same
// script. A late subscriber gets the delivered prefix, asserted against the real store because
// the sequence-gap rule is the store's own. The advance subscription and the computed-reply
// ordinal are here too. Teardown is in `failure-modes.test.ts` and the scripted-latency queue in
// `daemon.fixture.latency.test.ts`.

import { describe, expect, it } from "vitest";

import { APPLY_COALESCE_MS } from "@renderer/lib/reads/refresh-caps.js";

import { SCENARIO_TICK_MS, ScenarioEngine } from "./engine.fixture.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { BASE_STATE_CURSOR } from "@renderer/store/session/session-state.js";
import { SessionStore } from "@renderer/store/session/session-store.js";
import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a99a9";

/** A scenario whose only content is the beat script under test. */
function scenarioWithBeatsDueAt(dueMilliseconds: readonly number[]): Scenario {
  return {
    id: "engine-beat-order-probe",
    label: "Beat order",
    purpose: "Drives the engine's due-prefix rule with a script written in one exact order.",
    sessionId: SESSION_ID,
    userIdsInJoinOrder: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    replies: [],
    beats: dueMilliseconds.map((atMs, beatIndex) => ({
      atMs,
      event: {
        id: `019b79ee-0280-7ea1-8110-e5e0d115090${String(beatIndex)}`,
        sessionId: SESSION_ID,
        sequence: beatIndex + 1,
        kind: "run.starting",
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    })),
  };
}

/** Collect the event ids the engine delivers, in delivery order. */
function collectDeliveredEventIds(engine: ScenarioEngine): readonly string[] {
  const deliveredEventIds: string[] = [];
  engine.subscribe((events) => {
    for (const event of events) {
      deliveredEventIds.push(event.id);
    }
  });
  return deliveredEventIds;
}

describe("ScenarioEngine — the due prefix", () => {
  it("delivers each beat of an ordered script exactly once across advances", () => {
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([0, 40, 120]) });
    const delivered = collectDeliveredEventIds(engine);

    engine.advance(50);
    engine.advance(50);
    engine.advance(50);

    expect(delivered).toHaveLength(3);
    expect(new Set(delivered).size).toBe(3);
    expect(engine.progress.deliveredBeatCount).toBe(3);
    expect(engine.progress.isComplete).toBe(true);
  });

  it("delivers a later-due beat placed first without duplicating or dropping either", () => {
    // The control for this file. The second entry falls due at 10ms while the first does not;
    // a filter would emit it alone, count one beat consumed, then slice past the entry it never
    // sent and re-emit the one it had. Nothing is delivered until the entry in front is due.
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([100, 10]) });
    const delivered = collectDeliveredEventIds(engine);

    engine.advance(50);
    expect(delivered).toStrictEqual([]);
    expect(engine.progress.deliveredBeatCount).toBe(0);

    engine.advance(100);

    expect(delivered).toStrictEqual([
      "019b79ee-0280-7ea1-8110-e5e0d1150900",
      "019b79ee-0280-7ea1-8110-e5e0d1150901",
    ]);
    expect(engine.progress.deliveredBeatCount).toBe(2);
  });

  it("delivers beats sharing one tick together, in the order they are scripted", () => {
    // The ordering check requires nondecreasing `atMs`, not strictly increasing: an event and
    // the transition it triggers are ordinarily written at the same tick.
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([20, 20]) });
    const delivered = collectDeliveredEventIds(engine);

    engine.advance(20);

    expect(delivered).toStrictEqual([
      "019b79ee-0280-7ea1-8110-e5e0d1150900",
      "019b79ee-0280-7ea1-8110-e5e0d1150901",
    ]);
  });

  it("negative control: an advance that reaches no beat delivers nothing and consumes nothing", () => {
    // Without it, an engine that delivered the whole script on the first advance passes every
    // exactly-once case above.
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([80, 160]) });
    const delivered = collectDeliveredEventIds(engine);

    engine.advance(10);

    expect(delivered).toStrictEqual([]);
    expect(engine.progress.deliveredBeatCount).toBe(0);
    expect(engine.progress.isComplete).toBe(false);
  });
});

describe("ScenarioEngine — a whole-session subscription that attaches late", () => {
  /** The eight-beat script both late-attach cases are driven against. */
  function eightBeatScenario(): Scenario {
    return scenarioWithBeatsDueAt([0, 10, 20, 30, 40, 50, 60, 70]);
  }

  /** Collect what one replay-then-tail subscriber receives, in delivery order. */
  function collectWithReplay(engine: ScenarioEngine): readonly ProjectedSessionEvent[] {
    const received: ProjectedSessionEvent[] = [];
    engine.subscribe(
      (events) => {
        received.push(...events);
      },
      { replayDeliveredPrefix: true },
    );
    return received;
  }

  /**
   * A real store opened on the scenario's session, at the base state the fixture read answers
   * with. Real, because the claim is about the store's own gap rule.
   */
  function storeAtBaseState(scenario: Scenario): SessionStore {
    const store = new SessionStore({ sessionId: scenario.sessionId });
    store.initialize({ cursor: BASE_STATE_CURSOR, entities: [] });
    return store;
  }

  it("hands a subscriber attaching mid-script the delivered prefix, then tails", () => {
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });

    engine.advance(25);
    const received = collectWithReplay(engine);

    expect(received.map((event) => event.sequence)).toStrictEqual([1, 2, 3]);

    engine.advance(100);

    expect(received.map((event) => event.sequence)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("leaves a store opened mid-script ungapped and undegraded", () => {
    // Without the replay, the late store's first delivery is sequence 4 against a cursor of
    // zero, which reads as three missing rows: a gap, a sticky `sequence-gap` degradation and
    // a repair read the fixture cannot answer.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });
    const store = storeAtBaseState(scenario);

    engine.advance(25);
    engine.subscribe(
      (events) => {
        store.applyBatch(events);
      },
      { replayDeliveredPrefix: true },
    );
    engine.advance(100);

    expect(store.snapshot().gaps).toStrictEqual([]);
    expect(store.snapshot().degradedCause).toBeUndefined();
    expect(store.snapshot().cursor).toBe(scenario.beats.length);
    expect(store.snapshot().timeline).toHaveLength(scenario.beats.length);
  });

  it("hands a subscriber attaching after completion the whole script", () => {
    // A completed scenario emits nothing more, so without the replay a later store would have
    // no path to any state, silently.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });

    engine.runToCompletion();
    expect(engine.progress.isComplete).toBe(true);

    const received = collectWithReplay(engine);

    expect(received.map((event) => event.sequence)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("negative control: an early subscriber's delivery is unchanged, each beat once", () => {
    // Without it, an engine that replayed on every emission, or to a subscriber that already
    // had the prefix, passes every case above while delivering the opening beats twice.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });
    const received = collectWithReplay(engine);

    engine.advance(25);
    engine.advance(100);

    expect(received.map((event) => event.sequence)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("negative control: a subscriber that asks for no replay still receives no prefix", () => {
    // Replay is the whole-session stream's behavior, not the default: the narrowed run
    // streams and the relay are live.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });

    engine.advance(25);
    const tailOnly = collectDeliveredEventIds(engine);

    expect(tailOnly).toStrictEqual([]);

    engine.advance(10);

    expect(tailOnly).toHaveLength(1);
  });

  it("negative control: a disposed engine replays nothing into a late sink", () => {
    // A replay is a delivery, and a delivery after teardown lands in a store nobody consumes.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });

    engine.advance(25);
    engine.dispose();

    expect(collectWithReplay(engine)).toStrictEqual([]);
  });
});

describe("ScenarioEngine — the advance subscription", () => {
  it("publishes exactly one method for it, so no caller can sit on a second name", () => {
    // Two identical wrappers over one emitter would be duplicate-implementation drift. Read
    // off the prototype rather than a written list, so a second name fails here whatever it
    // is called.
    const advanceSubscriptions = Object.getOwnPropertyNames(ScenarioEngine.prototype).filter(
      (member) => member.startsWith("subscribeToAdvance"),
    );

    expect(advanceSubscriptions).toStrictEqual(["subscribeToAdvances"]);
  });

  it("hands the elapsed tick to its sink on every advance, after that advance's beats", () => {
    // An advance crossing no beat still wakes the sink, which a beat-driven schedule misses,
    // and one that crossed a beat wakes it after the beat, so the log has already moved.
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([40]) });
    const observed: string[] = [];
    engine.subscribe(() => {
      observed.push("beat");
    });
    engine.subscribeToAdvances((elapsedMs) => {
      observed.push(`advance ${String(elapsedMs)}`);
    });

    engine.advance(10);
    engine.advance(40);
    engine.advance(0);

    expect(observed).toStrictEqual(["advance 10", "beat", "advance 50", "advance 50"]);
  });

  it("negative control: an unsubscribed sink is handed no later advance", () => {
    // Without it, the case above passes over a subscription that never released, a pane's
    // schedule outliving the pane.
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([40]) });
    const ticks: number[] = [];
    const unsubscribe = engine.subscribeToAdvances((elapsedMs) => {
      ticks.push(elapsedMs);
    });

    engine.advance(10);
    unsubscribe();
    engine.advance(10);

    expect(ticks).toStrictEqual([10]);
  });
});

describe("ScenarioEngine — the computed-reply ordinal", () => {
  it("steps for each answer one call produces, and counts each call apart", () => {
    // Per call: the identity a mint gets is the Nth of its own kind, so a playback-wide counter
    // would number the first mint by the reads before it.
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([]) });

    const minted = [
      engine.nextComputedReplyOrdinal("session.create"),
      engine.nextComputedReplyOrdinal("session.create"),
      engine.nextComputedReplyOrdinal("session.create"),
    ];

    expect(minted).toStrictEqual([1, 2, 3]);
    expect(engine.nextComputedReplyOrdinal("session.read")).toBe(1);
  });

  it("negative control: the frozen clock cannot stand in for it", () => {
    // Two answers with no advance between them read the same tick, as two calls released by
    // one advance do, so a receipt keyed on the instant would collide.
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([]) });

    const firstInstant = engine.clock.now();
    const firstOrdinal = engine.nextComputedReplyOrdinal("session.create");
    const secondInstant = engine.clock.now();
    const secondOrdinal = engine.nextComputedReplyOrdinal("session.create");

    expect(secondInstant).toBe(firstInstant);
    expect(secondOrdinal).not.toBe(firstOrdinal);
  });
});

describe("ScenarioEngine — the tick", () => {
  it("is a whole number of milliseconds, because scripts are expressed in whole ticks", () => {
    expect(Number.isInteger(SCENARIO_TICK_MS)).toBe(true);
  });
});

describe("the fixture tick names one frame", () => {
  it("is longer than the coalescing window", () => {
    // A tick inside the coalescing window would fold two ticks into one notification and stop
    // naming one exact frame, which the screenshot target's byte-stability rests on.
    expect(SCENARIO_TICK_MS).toBeGreaterThan(APPLY_COALESCE_MS);
  });
});
