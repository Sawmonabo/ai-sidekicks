// A scripted latency is spent on the fixture clock and by nobody else. A reply parked on the
// engine leaves the loading state reachable and delivers no unrelated beats. Two failures a
// resolving assertion would not see are cases of their own: a reply pending at teardown is a
// promise nobody can settle, and an unbounded backlog grows without limit. Both refuse. Every case
// drives the real fixture bridge and engine.

import { describe, expect, it } from "vitest";

import { FixtureBridgeError } from "./refusal.fixture.js";
import {
  DELAYED_CALL,
  DELAYED_RESULT,
  SCRIPTED_LATENCY_MS,
  callThroughBridge,
  createFixture,
  subscribeToSessionStream,
} from "@test/helpers/fixture-bridge.js";
import { crossMacrotaskBoundary } from "@test/helpers/macrotask-boundary.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { SCENARIO_PENDING_REPLY_CAP } from "./engine.fixture.js";

/** The concurrent-streaming scenario script, re-scripted so its one read carries a latency. */
function scenarioWithDelayedReply(afterMs: number): Scenario {
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id: "concurrent-streaming-delayed-reply-probe",
    replies: [{ call: DELAYED_CALL, result: DELAYED_RESULT, afterMs }],
  };
}

/** The same script and reply with no latency: the control. */
function scenarioWithImmediateReply(): Scenario {
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id: "concurrent-streaming-immediate-reply-probe",
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

    await crossMacrotaskBoundary();
    // A reply that resolved on the calling turn would leave no loading window.
    expect(settled).toBe(false);
    expect(fixture.engine.pendingReplyCount).toBe(1);

    fixture.engine.advance(SCRIPTED_LATENCY_MS);

    await expect(pending).resolves.toStrictEqual(DELAYED_RESULT);
    expect(fixture.engine.pendingReplyCount).toBe(0);
  });

  it("emits no beat and moves no clock merely by being called", async () => {
    const fixture = createFixture(scenarioWithDelayedReply(SCRIPTED_LATENCY_MS));
    const received = subscribeToSessionStream(fixture);

    void callThroughBridge(fixture, DELAYED_CALL);
    await crossMacrotaskBoundary();

    // A request is not a tick; no wire delivers beats as a side effect of a read.
    expect(received.frames).toStrictEqual([]);
    expect(fixture.engine.progress.elapsedMs).toBe(0);
    expect(fixture.engine.progress.deliveredBeatCount).toBe(0);
  });

  it("negative control: an undelayed reply resolves with no advance at all", async () => {
    // Without it, a fixture that never resolved anything passes every pending assertion above.
    const fixture = createFixture(scenarioWithImmediateReply());

    await expect(callThroughBridge(fixture, DELAYED_CALL)).resolves.toStrictEqual(DELAYED_RESULT);
    expect(fixture.engine.pendingReplyCount).toBe(0);
    expect(fixture.engine.progress.elapsedMs).toBe(0);
  });

  it("refuses a reply still pending when the engine is torn down", async () => {
    const fixture = createFixture(scenarioWithDelayedReply(SCRIPTED_LATENCY_MS));
    const pending = callThroughBridge(fixture, DELAYED_CALL);

    fixture.engine.dispose();

    // Settled rather than left hanging, or a view stays loading for the life of the window.
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
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "concurrent-streaming-two-latencies-probe",
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
