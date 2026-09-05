// The two mechanisms, driven apart on frozen time.
//
// Everything here turns on the asymmetry the module is built around: a composing
// entry expires and an agent entry does not. A test that only checked "an indicator
// appears" would pass over a registry that expired both, which is the defect.

import { describe, expect, it } from "vitest";

import { ManualClock } from "../core/index.js";
import { frozenStartMilliseconds } from "./frozen-start.test-support.js";
import { ActivityIndicatorRegistry } from "./activity-model.js";
import { COMPOSING_RECEIVED_STALE_MS } from "../core/index.js";

describe("activity indicators — a human's is timed", () => {
  it("clears a composing indicator once the receive bound passes", () => {
    const clock = new ManualClock(frozenStartMilliseconds());
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(registry.activityIn("channel-main").composing).toHaveLength(1);
    clock.advance(COMPOSING_RECEIVED_STALE_MS);
    expect(registry.activityIn("channel-main").composing).toHaveLength(0);
  });

  it("negative control: it is still there one millisecond before the bound", () => {
    const clock = new ManualClock(frozenStartMilliseconds());
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    clock.advance(COMPOSING_RECEIVED_STALE_MS - 1);
    expect(registry.activityIn("channel-main").composing).toHaveLength(1);
  });

  it("measures the deadline from the note and never from the publisher's `since`", () => {
    // `since` is an hour old. If it were an expiry input the entry would already be
    // gone; the deadline is the console's own clock at the moment it was noted.
    const clock = new ManualClock(frozenStartMilliseconds());
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-main",
      since: "2026-01-01T09:00:00.000Z",
    });
    clock.advance(COMPOSING_RECEIVED_STALE_MS - 1);
    expect(registry.activityIn("channel-main").composing).toHaveLength(1);
  });

  it("moves a composer rather than showing them in two rooms", () => {
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-review",
      since: "2026-01-01T10:00:01.000Z",
    });
    expect(registry.activityIn("channel-main").composing).toHaveLength(0);
    expect(registry.activityIn("channel-review").composing).toHaveLength(1);
    expect(registry.composingChannelFor("participant-one")).toBe("channel-review");
  });
});

describe("activity indicators — an agent's is edge-triggered", () => {
  it("survives far past the composing bound", () => {
    // A twenty-minute compile emits nothing while it runs; expiring it would make a
    // long run flicker.
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    clock.advance(COMPOSING_RECEIVED_STALE_MS * 100);
    expect(registry.activityIn("channel-main").agentRuns).toHaveLength(1);
    expect(clock.pendingCount).toBe(0);
  });

  it("clears on its own run's end edge", () => {
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    registry.clearAgentActivity("run-1");
    expect(registry.activityIn("channel-main").agentRuns).toHaveLength(0);
  });

  it("negative control: another run's end edge leaves it alone", () => {
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    registry.clearAgentActivity("run-2");
    expect(registry.activityIn("channel-main").agentRuns).toHaveLength(1);
  });
});

describe("activity indicators — disconnect and teardown", () => {
  it("clears everything one publisher wrote when its client drops", () => {
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    registry.clearPublisher("participant-one", ["run-1"]);
    expect(registry.activityIn("channel-main")).toStrictEqual({ composing: [], agentRuns: [] });
  });

  it("releases every armed clear on dispose", () => {
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(clock.pendingCount).toBe(1);
    registry.dispose();
    expect(clock.pendingCount).toBe(0);
    registry.noteComposing({
      participantId: "participant-two",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(clock.pendingCount).toBe(0);
  });
});

describe("activity indicators — the snapshot React reads", () => {
  it("returns the same value until something changes", () => {
    // Identity stability is a correctness requirement, not a saving: React's
    // external-store binding re-reads whenever the snapshot differs, so a fresh
    // array every call would never converge.
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(registry.activityIn("channel-main")).toBe(registry.activityIn("channel-main"));
  });

  it("negative control: a change hands back a different value", () => {
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    registry.noteComposing({
      participantId: "participant-one",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    const before = registry.activityIn("channel-main");
    registry.noteComposing({
      participantId: "participant-two",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(registry.activityIn("channel-main")).not.toBe(before);
  });

  it("tells its listeners once per change", () => {
    const clock = new ManualClock();
    const registry = new ActivityIndicatorRegistry(clock);
    let changeCount = 0;
    registry.onChange(() => {
      changeCount += 1;
    });
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    registry.clearAgentActivity("run-1");
    // A clear of something that was never there changes nothing and says nothing.
    registry.clearAgentActivity("run-1");
    expect(changeCount).toBe(2);
  });
});
