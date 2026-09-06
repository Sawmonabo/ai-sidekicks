import { describe, expect, it, vi } from "vitest";

import { ScenarioEngine, type ConsoleScenario } from "../scenario-runtime/index.js";
import { TransportReconnectSignal } from "../transport/transport-reconnect.js";
import { isTransportLostAt, playScenarioTransportOutages } from "./fixture-transport-outages.js";

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
