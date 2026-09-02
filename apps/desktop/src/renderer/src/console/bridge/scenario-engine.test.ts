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
// WHAT IS NOT HERE. Teardown — the disposed engine's dropped ticks and abandoned
// replies — is `failure-modes.test.ts`'s, and the scripted-latency queue is
// `fixture-bridge.latency.test.ts`'s. This file owns beat delivery and nothing else.

import { describe, expect, it } from "vitest";

import { ScenarioEngine } from "./scenario-engine.js";
import type { ConsoleScenario } from "./scenario.js";

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
