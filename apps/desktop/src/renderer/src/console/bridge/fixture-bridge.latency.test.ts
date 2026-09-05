// A scripted latency is spent on the fixture clock, and by nobody else.
//
// The second of the three places a fixture that matched `SidekicksBridge`'s SHAPE
// still answered something the live bridge never would: a reply carrying `afterMs`
// advanced the clock itself and resolved immediately, so the loading state it
// exists to make reachable was never reachable, and merely issuing a request
// delivered scenario beats that had nothing to do with it.
//
// What replaced it parks the reply on the engine, which means two failures that a
// resolving assertion alone would not see are cases here in their own right: a
// reply pending when the engine is torn down is a promise nobody can ever settle,
// and a backlog with no bound is a fixture that grows one entry per unanswered
// call for the life of the window. Both refuse, and the refusal is the claim.
//
// Every case drives the REAL fixture bridge over a real scenario and the real
// engine. A hand-written stand-in for either would pass over exactly the seam
// these cases exist to hold.

import { describe, expect, it } from "vitest";

import { FixtureBridgeError } from "./fixture-refusal.js";
import {
  DELAYED_CALL,
  DELAYED_RESULT,
  SCRIPTED_LATENCY_MS,
  callThroughBridge,
  createFixture,
  drainMicrotasks,
  subscribeThroughBridge,
} from "./fixture-bridge.test-support.js";
import type { ConsoleScenario } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { SESSION_EVENT_STREAM } from "./session-event-streams.js";
import { SCENARIO_PENDING_REPLY_CAP } from "../core/index.js";

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
