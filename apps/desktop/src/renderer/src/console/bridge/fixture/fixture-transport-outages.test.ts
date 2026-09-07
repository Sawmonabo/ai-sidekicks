import { describe, expect, it, vi } from "vitest";

import { ScenarioEngine, type ConsoleScenario } from "../scenario-runtime/index.js";
import {
  TransportReconnectSignal,
  type TransportReachability,
} from "../transport/transport-reconnect.js";
import { isTransportLostAt, playScenarioTransportOutages } from "./fixture-transport-outages.js";

/** One observation the player made, in the order it made it. */
type ObservedReachability = Exclude<TransportReachability, "unknown">;

/**
 * Record every state the player reports, in order, and still report it.
 *
 * `reachability` alone answers where the walk ENDED, which is exactly the reading that
 * could not tell a crossed outage from one that never happened — so the cases below
 * assert the sequence. The spy delegates to the real method rather than standing in for
 * it, so what is measured is the shipped signal deciding what an edge is.
 */
function recordObservations(signal: TransportReconnectSignal): readonly ObservedReachability[] {
  const observed: ObservedReachability[] = [];
  const reportToSignal = signal.observe.bind(signal);
  vi.spyOn(signal, "observe").mockImplementation((reachability: ObservedReachability) => {
    observed.push(reachability);
    reportToSignal(reachability);
  });
  return observed;
}

function scenarioWithOutages(
  transportOutages?: NonNullable<ConsoleScenario["transportOutages"]>,
): ConsoleScenario {
  // Spread rather than assigned, because `exactOptionalPropertyTypes` makes an
  // explicit `undefined` a different thing from an absent member — and the absent
  // case is exactly the one the first assertion below is about.
  return {
    id: "outage-probe",
    label: "Outage probe",
    purpose: "Drives the transport signal from a scripted outage.",
    sessionId: "session-outage",
    participantIdsInJoinOrder: ["participant-you"],
    beats: [],
    replies: [],
    startedAtIso: "2026-01-01T00:00:00.000Z",
    ...(transportOutages === undefined ? {} : { transportOutages }),
  };
}

describe("isTransportLostAt", () => {
  const outages = [{ lostAtMs: 100, restoredAtMs: 400 }];

  it("is reachable before the loss", () => {
    expect(isTransportLostAt(outages, 99)).toBe(false);
  });

  it("is away from the loss instant onwards", () => {
    expect(isTransportLostAt(outages, 100)).toBe(true);
    expect(isTransportLostAt(outages, 399)).toBe(true);
  });

  it("is back AT the restore instant, not one tick after it", () => {
    expect(isTransportLostAt(outages, 400)).toBe(false);
  });
});

describe("playScenarioTransportOutages", () => {
  it("takes no subscription for a scenario that scripts no outage", () => {
    const engine = new ScenarioEngine({ scenario: scenarioWithOutages() });
    const signal = new TransportReconnectSignal();

    playScenarioTransportOutages(engine, signal);
    engine.advance(1_000);

    expect(signal.reachability).toBe("unknown");
  });

  it("drives the signal through the outage and back", () => {
    const engine = new ScenarioEngine({
      scenario: scenarioWithOutages([{ lostAtMs: 100, restoredAtMs: 400 }]),
    });
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(50);
    expect(signal.reachability).toBe("reachable");
    expect(onReconnect).not.toHaveBeenCalled();

    engine.advance(100);
    expect(signal.reachability).toBe("unreachable");
    expect(onReconnect).not.toHaveBeenCalled();

    engine.advance(300);
    expect(signal.reachability).toBe("reachable");
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("fires on an advance that carries no beat, which is the whole point", () => {
    // Nothing is scripted in this scenario's log at all, so a schedule bound to beats
    // would never wake and the reconnect would never reach a reading.
    const engine = new ScenarioEngine({
      scenario: scenarioWithOutages([{ lostAtMs: 10, restoredAtMs: 20 }]),
    });
    const signal = new TransportReconnectSignal();
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(15);
    engine.advance(10);

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("plays a whole outage crossed by ONE advance, edges included", () => {
    // The regression this closes: the pass sampled only the instant the advance landed
    // on, so an advance from before the loss to after the restore read `reachable`,
    // reported `reachable`, and the signal never saw the loss at all — no returning
    // edge, and every reading wired to `reconnect` stayed as stale as it was. A single
    // advance across a whole outage is what a screenshot step, an endurance step and
    // `runToCompletion` each perform.
    const engine = new ScenarioEngine({
      scenario: scenarioWithOutages([{ lostAtMs: 100, restoredAtMs: 400 }]),
    });
    const signal = new TransportReconnectSignal();
    const observed = recordObservations(signal);
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(10_000);

    expect(observed).toStrictEqual(["unreachable", "reachable", "reachable"]);
    expect(signal.reachability).toBe("reachable");
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("negative control: an advance landing INSIDE the outage plays the loss alone", () => {
    // Without this the case above would pass over a player that reported both edges on
    // every advance regardless of where it landed, which would announce a wire back
    // while it is still away.
    const engine = new ScenarioEngine({
      scenario: scenarioWithOutages([{ lostAtMs: 100, restoredAtMs: 400 }]),
    });
    const signal = new TransportReconnectSignal();
    const observed = recordObservations(signal);
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(250);

    expect(observed).toStrictEqual(["unreachable", "unreachable"]);
    expect(signal.reachability).toBe("unreachable");
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("plays two outages crossed by one advance as four transitions, in order", () => {
    const engine = new ScenarioEngine({
      scenario: scenarioWithOutages([
        { lostAtMs: 100, restoredAtMs: 200 },
        { lostAtMs: 300, restoredAtMs: 400 },
      ]),
    });
    const signal = new TransportReconnectSignal();
    const observed = recordObservations(signal);
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(500);

    expect(observed).toStrictEqual([
      "unreachable",
      "reachable",
      "unreachable",
      "reachable",
      "reachable",
    ]);
    // Two outages are two returning edges. A player that collapsed them would report
    // one reconnect for two separate losses, and the reading that missed the first
    // one's worth of the stream would never re-read for it.
    expect(onReconnect).toHaveBeenCalledTimes(2);
  });

  it("plays each boundary exactly once across successive advances", () => {
    // The other half of "crossed", and the one a state SAMPLE gets right for free: a
    // boundary already played must not be played again by the next advance, or every
    // advance after an outage would re-announce its restore.
    const engine = new ScenarioEngine({
      scenario: scenarioWithOutages([{ lostAtMs: 100, restoredAtMs: 400 }]),
    });
    const signal = new TransportReconnectSignal();
    const observed = recordObservations(signal);
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(150);
    engine.advance(300);
    engine.advance(300);

    expect(observed).toStrictEqual([
      "unreachable",
      "unreachable",
      "reachable",
      "reachable",
      "reachable",
    ]);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("plays an outage scripted at tick zero rather than stepping over it", () => {
    // The fixture bridge binds this player before anything can advance the clock for
    // exactly this case. A walk keyed on a remembered position starting at zero would
    // need a sentinel below zero to admit a boundary AT zero; removing a played prefix
    // needs none.
    const engine = new ScenarioEngine({
      scenario: scenarioWithOutages([{ lostAtMs: 0, restoredAtMs: 40 }]),
    });
    const signal = new TransportReconnectSignal();
    const observed = recordObservations(signal);
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(100);

    expect(observed).toStrictEqual(["unreachable", "reachable", "reachable"]);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("plays overlapping outages as one, so the walk and the predicate agree", () => {
    // Two outages the transport is inside without interruption are ONE outage: the
    // predicate beside this player is a `.some` over the union, so per-outage edges
    // would announce a restore at 300 that `isTransportLostAt(300)` denies — and the
    // endpoint sample would then correct it, emitting a returning edge for a wire that
    // never came back.
    const overlapping = [
      { lostAtMs: 100, restoredAtMs: 300 },
      { lostAtMs: 200, restoredAtMs: 400 },
    ];
    expect(isTransportLostAt(overlapping, 300)).toBe(true);

    const engine = new ScenarioEngine({ scenario: scenarioWithOutages(overlapping) });
    const signal = new TransportReconnectSignal();
    const observed = recordObservations(signal);
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(500);

    expect(observed).toStrictEqual(["unreachable", "reachable", "reachable"]);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("plays nothing for an outage the transport is never inside", () => {
    // `restoredAtMs` at or before `lostAtMs` is an interval the half-open predicate
    // says nobody was ever in, so a pair of transitions around it would be a reconnect
    // for a loss that never happened.
    const empty = [{ lostAtMs: 100, restoredAtMs: 100 }];
    expect(isTransportLostAt(empty, 100)).toBe(false);

    const engine = new ScenarioEngine({ scenario: scenarioWithOutages(empty) });
    const signal = new TransportReconnectSignal();
    const observed = recordObservations(signal);
    const onReconnect = vi.fn();
    signal.subscribe(onReconnect);
    playScenarioTransportOutages(engine, signal);

    engine.advance(500);

    expect(observed).toStrictEqual(["reachable"]);
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it("stops reporting once released", () => {
    const engine = new ScenarioEngine({
      scenario: scenarioWithOutages([{ lostAtMs: 100, restoredAtMs: 400 }]),
    });
    const signal = new TransportReconnectSignal();
    const release = playScenarioTransportOutages(engine, signal);

    engine.advance(150);
    release();
    engine.advance(500);

    expect(signal.reachability).toBe("unreachable");
  });
});
