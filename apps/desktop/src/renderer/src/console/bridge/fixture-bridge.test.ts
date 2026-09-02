// The fixture bridge answers the question it was asked, on the clock it declares.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge makes the fixture
// shape-identical to `SidekicksBridge`, and I-023-13 turns that into a checked
// claim. Shape is the cheap half. This file is the other half — the two places
// where a fixture that matched the contract's SHAPE was still answering something
// the live bridge never would:
//
//   • **A subscription named an event and got the whole script.** `daemon.subscribe`
//     takes an event name and the fixture ignored it, so a surface subscribed to
//     `run.started` was handed `session.created` and `participant.joined` too, each
//     cast to the type it had asked for. A screenshot or an end-to-end result taken
//     against that is a result the live bridge cannot produce.
//   • **A scripted latency was spent by the caller, on the calling turn.** A reply
//     carrying `afterMs` advanced the clock itself and resolved immediately, so the
//     loading state it exists to make reachable was never reachable, and merely
//     issuing a request delivered scenario beats that had nothing to do with it.
//
// Every case drives the REAL fixture bridge over a real scenario and the real
// engine. A hand-written stand-in for either would pass over exactly the seam
// these cases exist to hold.

import { describe, expect, it } from "vitest";

import type { DaemonEvent, DaemonMethod } from "@ai-sidekicks/contracts";

import { SESSION_EVENT_STREAM } from "./console-bridge.js";
import { createFixtureBridge, FixtureBridgeError } from "./fixture-bridge.js";
import type { ConsoleScenario, ScenarioEngine } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { SCENARIO_PENDING_REPLY_CAP } from "../core/index.js";
import type { ConsoleSessionEvent } from "../store/index.js";

/** Past the flagship script's last beat, which is at 400 ms. */
const PAST_EVERY_BEAT_MS = 500;

/** The scripted latency the delayed-reply cases spend. Longer than one tick. */
const SCRIPTED_LATENCY_MS = 120;

/** The one call the delayed-reply scenario scripts an answer for. */
const DELAYED_CALL = "session.list";

/** What a delayed call resolves to, asserted verbatim so a stub cannot pass. */
const DELAYED_RESULT = { sessions: [] };

interface FixtureUnderTest {
  readonly bridge: ReturnType<typeof createFixtureBridge>;
  readonly engine: ScenarioEngine;
}

function createFixture(scenario: ConsoleScenario = FLAGSHIP_SCENARIO): FixtureUnderTest {
  const bridge = createFixtureBridge({ scenario });
  const engine = bridge.scenarioEngine;
  if (engine === undefined) {
    throw new Error("the fixture bridge built no scenario engine, so there is nothing to drive");
  }
  return { bridge, engine };
}

/** The flagship script, re-scripted so its one read carries a latency. */
function scenarioWithDelayedReply(afterMs: number): ConsoleScenario {
  return {
    ...FLAGSHIP_SCENARIO,
    id: "flagship-delayed-reply-probe",
    replies: [{ call: DELAYED_CALL, result: DELAYED_RESULT, afterMs }],
  };
}

/** The same script with the same reply and no latency at all. The control. */
function scenarioWithImmediateReply(): ConsoleScenario {
  return {
    ...FLAGSHIP_SCENARIO,
    id: "flagship-immediate-reply-probe",
    replies: [{ call: DELAYED_CALL, result: DELAYED_RESULT }],
  };
}

/**
 * Subscribe through the bridge exactly as a surface would.
 *
 * The event name is cast to the `DaemonEvent` brand and the payload left
 * `unknown` — the same single brand bypass the two shipped renderer families
 * make, because `DaemonEvent` is a `never`-shaped Plan-007 stub and a tighter
 * payload type here would be a fiction.
 */
function subscribeThroughBridge(
  fixture: FixtureUnderTest,
  eventName: string,
): readonly ConsoleSessionEvent[] {
  const received: ConsoleSessionEvent[] = [];
  fixture.bridge.sidekicks.daemon.subscribe(eventName as DaemonEvent, (payload: unknown) => {
    received.push(payload as ConsoleSessionEvent);
  });
  return received;
}

function callThroughBridge(fixture: FixtureUnderTest, method: string): Promise<unknown> {
  return fixture.bridge.sidekicks.daemon.call(method as DaemonMethod, undefined);
}

/**
 * Let every pending microtask chain run.
 *
 * A macrotask boundary rather than a counted number of `await`s: the old
 * behaviour settled a delayed reply two or three microtasks deep, so a count
 * would have to be tuned against the implementation it is meant to hold.
 */
function drainMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe("fixture bridge — a subscription delivers only the event it named", () => {
  it("hands a kind subscriber that kind's beats and no others", () => {
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, "run.started");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // The flagship script carries five kinds. A subscriber that named one of them
    // is handed one of them — never `session.created`, which arrives first and is
    // what an unfiltered fixture delivers into a `run.started` handler.
    expect(received.map((event) => event.kind)).toStrictEqual(["run.started"]);
  });

  it("negative control: the session stream still receives every beat", () => {
    // Without this, a filter that delivered nothing at all would pass the case
    // above — and the console's one real subscriber names the STREAM, so a
    // blanket filter would silence the whole console rather than tidy it.
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received).toHaveLength(FLAGSHIP_SCENARIO.beats.length);
    expect(new Set(received.map((event) => event.kind)).size).toBeGreaterThan(1);
  });

  it("delivers nothing to a subscriber whose kind the script never plays", () => {
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, "run.failed");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received).toStrictEqual([]);
  });

  it("keeps the two arms independent, so one subscription cannot feed another", () => {
    const fixture = createFixture();
    const streamed = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);
    const attached = subscribeThroughBridge(fixture, "agent.attached");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(streamed).toHaveLength(FLAGSHIP_SCENARIO.beats.length);
    expect(attached.map((event) => event.kind)).toStrictEqual([
      "agent.attached",
      "agent.attached",
      "agent.attached",
      "agent.attached",
    ]);
  });
});

describe("fixture bridge — a scripted latency is spent on the fixture clock", () => {
  it("holds a delayed reply until the caller advances past it", async () => {
    const fixture = createFixture(scenarioWithDelayedReply(SCRIPTED_LATENCY_MS));
    let settled = false;
    const pending = callThroughBridge(fixture, DELAYED_CALL).then((result) => {
      settled = true;
      return result;
    });

    await drainMicrotasks();
    // The whole point of a scripted latency: there is a window in which the
    // surface is loading. A reply that resolved on the calling turn has none.
    expect(settled).toBe(false);
    expect(fixture.engine.pendingReplyCount).toBe(1);

    fixture.engine.advance(SCRIPTED_LATENCY_MS);

    await expect(pending).resolves.toStrictEqual(DELAYED_RESULT);
    expect(fixture.engine.pendingReplyCount).toBe(0);
  });

  it("emits no beat and moves no clock merely by being called", async () => {
    const fixture = createFixture(scenarioWithDelayedReply(SCRIPTED_LATENCY_MS));
    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    void callThroughBridge(fixture, DELAYED_CALL);
    await drainMicrotasks();

    // A request is not a tick. A fixture that advanced its own clock to serve a
    // latency delivered every beat that fell inside the latency as a side effect
    // of a read, which no wire does.
    expect(received).toStrictEqual([]);
    expect(fixture.engine.progress.elapsedMs).toBe(0);
    expect(fixture.engine.progress.deliveredBeatCount).toBe(0);
  });

  it("negative control: an undelayed reply resolves with no advance at all", async () => {
    // Without this, an implementation that never resolved anything would pass
    // every pending assertion above.
    const fixture = createFixture(scenarioWithImmediateReply());

    await expect(callThroughBridge(fixture, DELAYED_CALL)).resolves.toStrictEqual(DELAYED_RESULT);
    expect(fixture.engine.pendingReplyCount).toBe(0);
    expect(fixture.engine.progress.elapsedMs).toBe(0);
  });

  it("refuses a reply still pending when the engine is torn down", async () => {
    const fixture = createFixture(scenarioWithDelayedReply(SCRIPTED_LATENCY_MS));
    const pending = callThroughBridge(fixture, DELAYED_CALL);

    fixture.engine.dispose();

    // Settled rather than left hanging: a promise nobody can ever resolve is a
    // surface stuck on its loading state for the life of the window.
    await expect(pending).rejects.toBeInstanceOf(FixtureBridgeError);
    await expect(pending).rejects.toMatchObject({
      refusal: { code: "reply-abandoned", origin: "fixture-bridge" },
    });
    expect(fixture.engine.pendingReplyCount).toBe(0);
  });

  it("refuses once the pending backlog is full rather than growing without bound", async () => {
    const fixture = createFixture(scenarioWithDelayedReply(SCRIPTED_LATENCY_MS));
    const held = Array.from({ length: SCENARIO_PENDING_REPLY_CAP }, () =>
      callThroughBridge(fixture, DELAYED_CALL),
    );
    const overflowing = callThroughBridge(fixture, DELAYED_CALL);

    await expect(overflowing).rejects.toMatchObject({
      refusal: { code: "reply-backlog-full", origin: "fixture-bridge" },
    });
    expect(fixture.engine.pendingReplyCount).toBe(SCENARIO_PENDING_REPLY_CAP);

    fixture.engine.advance(SCRIPTED_LATENCY_MS);
    await expect(Promise.all(held)).resolves.toHaveLength(SCENARIO_PENDING_REPLY_CAP);
  });

  it("releases pending replies in due order, so a longer latency lands later", async () => {
    const fixture = createFixture({
      ...FLAGSHIP_SCENARIO,
      id: "flagship-two-latencies-probe",
      replies: [
        { call: "agent.list", result: { agents: [] }, afterMs: SCRIPTED_LATENCY_MS * 2 },
        { call: DELAYED_CALL, result: DELAYED_RESULT, afterMs: SCRIPTED_LATENCY_MS },
      ],
    });
    const order: string[] = [];
    const slower = callThroughBridge(fixture, "agent.list").then(() => order.push("agent.list"));
    const quicker = callThroughBridge(fixture, DELAYED_CALL).then(() => order.push(DELAYED_CALL));

    fixture.engine.advance(SCRIPTED_LATENCY_MS * 2);
    await Promise.all([slower, quicker]);

    expect(order).toStrictEqual([DELAYED_CALL, "agent.list"]);
  });
});
