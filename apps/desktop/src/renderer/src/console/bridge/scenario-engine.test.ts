// Every beat reaches a subscriber exactly once, whatever order the script is in.
//
// The engine's count and the set it has actually delivered are one claim, and the
// old delivery filter let them come apart: it picked every remaining beat that had
// fallen due — including one sitting behind an entry that had not — and then
// advanced `deliveredBeatCount` as though a prefix had been consumed. The next
// advance sliced past the entry it had skipped, so one beat was delivered twice and
// another never at all. Both halves are asserted below, against the same script, so
// a fix that only stopped the duplicate would still fail.
//
// The second claim in this file is what a LATE subscriber receives. The engine
// registered a sink for future emissions only, so a store opened after the clock had
// already delivered beats read the next one as a real sequence gap — the fixture's
// snapshot answers at cursor zero, so every position in between counts as missing —
// and a store opened after the script finished stayed empty. Both are asserted here
// against the REAL store rather than against a count, because the gap is the store's
// own rule and a test that restated it would be checking its own copy.
//
// WHAT IS NOT HERE. Teardown — the disposed engine's dropped ticks and abandoned
// replies — is `failure-modes.test.ts`'s, and the scripted-latency queue is
// `fixture-bridge.latency.test.ts`'s. This file owns beat delivery and nothing else.

import { describe, expect, it } from "vitest";

import { BASE_STATE_CURSOR } from "./fixture-session-snapshot.js";
import { ScenarioEngine } from "./scenario-engine.js";
import type { ConsoleScenario } from "./scenario.js";
import { SessionStore } from "../store/index.js";
import type { ConsoleSessionEvent } from "../store/index.js";

const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a99a9";

/** A scenario whose only content is the beat script under test. */
function scenarioWithBeatsDueAt(dueMilliseconds: readonly number[]): ConsoleScenario {
  return {
    id: "engine-beat-order-probe",
    label: "Beat order",
    purpose: "Drives the engine's due-prefix rule with a script written in one exact order.",
    sessionId: SESSION_ID,
    participantIdsInJoinOrder: [],
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
    // THE control for this file, and it fails on the old filter in two ways at
    // once: the second entry falls due at 10ms while the first does not, so the
    // old code emitted it alone, counted one beat consumed, and on the next
    // advance sliced past the entry it had never sent — re-emitting the one it
    // had. Here nothing is delivered until the entry in front is due, and then
    // both go in script order.
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
    // Nondecreasing rather than strictly increasing is the rule the ordering check
    // enforces, so the engine has to serve it: a session event and the transition
    // it triggers are ordinarily written at the same tick.
    const engine = new ScenarioEngine({ scenario: scenarioWithBeatsDueAt([20, 20]) });
    const delivered = collectDeliveredEventIds(engine);

    engine.advance(20);

    expect(delivered).toStrictEqual([
      "019b79ee-0280-7ea1-8110-e5e0d1150900",
      "019b79ee-0280-7ea1-8110-e5e0d1150901",
    ]);
  });

  it("negative control: an advance that reaches no beat delivers nothing and consumes nothing", () => {
    // Without it, an engine that delivered the whole script on the first advance
    // would pass every exactly-once case above.
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
  function eightBeatScenario(): ConsoleScenario {
    return scenarioWithBeatsDueAt([0, 10, 20, 30, 40, 50, 60, 70]);
  }

  /** Collect what one replay-then-tail subscriber receives, in delivery order. */
  function collectWithReplay(engine: ScenarioEngine): readonly ConsoleSessionEvent[] {
    const received: ConsoleSessionEvent[] = [];
    engine.subscribe(
      (events) => {
        received.push(...events);
      },
      { replayDeliveredPrefix: true },
    );
    return received;
  }

  /**
   * A real store opened on the scenario's session, at the base state the fixture
   * read answers with.
   *
   * The real `SessionStore` and the real `BASE_STATE_CURSOR`, because the claim is
   * about the store's own gap rule: a test that counted sequences itself would be
   * asserting its own arithmetic rather than the rule a degraded banner comes from.
   */
  function storeAtBaseState(scenario: ConsoleScenario): SessionStore {
    const store = new SessionStore({ sessionId: scenario.sessionId });
    store.initialise({ cursor: BASE_STATE_CURSOR, entities: [], participantJoinLog: [] });
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
    // The reason the replay exists, stated in the store's own terms. Before it the
    // late store's first delivery was sequence 4 against a cursor of zero, which the
    // reconciler reads as three missing rows: a recorded gap, a sticky
    // `sequence-gap` degradation, and a repair read the fixture cannot answer.
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
    // The other half, and the one that is silent rather than degraded: a scenario
    // already run to completion emits nothing more, so a store opened afterwards had
    // no path to any state at all.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });

    engine.runToCompletion();
    expect(engine.progress.isComplete).toBe(true);

    const received = collectWithReplay(engine);

    expect(received.map((event) => event.sequence)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("negative control: an early subscriber's delivery is unchanged, each beat once", () => {
    // Without this, an engine that replayed on every emission — or one that replayed
    // to a subscriber that had already received the prefix — would pass every case
    // above while delivering the opening beats twice to the console's real
    // subscriber, which is a duplicate the store would silently drop and a timeline
    // that would read as though the session had happened twice.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });
    const received = collectWithReplay(engine);

    engine.advance(25);
    engine.advance(100);

    expect(received.map((event) => event.sequence)).toStrictEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("negative control: a subscriber that asks for no replay still receives no prefix", () => {
    // Replay is the whole-session stream's registered behaviour and not the engine's
    // default: the narrowed run streams and the relay are live, and an engine that
    // replayed unconditionally would hand a runs surface transitions it never
    // subscribed in time for.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });

    engine.advance(25);
    const tailOnly = collectDeliveredEventIds(engine);

    expect(tailOnly).toStrictEqual([]);

    engine.advance(10);

    expect(tailOnly).toHaveLength(1);
  });

  it("negative control: a disposed engine replays nothing into a late sink", () => {
    // A replay is a delivery, and this module's teardown rule is that a delivery
    // after teardown lands in a store that no longer has a consumer.
    const scenario = eightBeatScenario();
    const engine = new ScenarioEngine({ scenario });

    engine.advance(25);
    engine.dispose();

    expect(collectWithReplay(engine)).toStrictEqual([]);
  });
});
