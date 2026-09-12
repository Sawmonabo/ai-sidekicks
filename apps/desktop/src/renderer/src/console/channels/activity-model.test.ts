// The one mechanism, driven on frozen time.
//
// Everything here turns on the rule the module is built around: an entry has no
// deadline and leaves by its own run's end edge. A test that only checked "an indicator
// appears" would pass over a registry that expired it, which is the defect.

import { afterEach, describe, expect, it, vi } from "vitest";

import { ActivityIndicatorRegistry } from "./activity-model.js";

/** Long enough that any deadline a receiver-timed design would arm has passed. */
const PAST_ANY_PLAUSIBLE_DEADLINE_MS = 60 * 60 * 1_000;

describe("activity indicators — an agent's is edge-triggered", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("survives however long the run takes, because nothing arms a timer", () => {
    // A twenty-minute compile emits nothing while it runs; expiring it would make a
    // long run flicker. Read on the environment's own timer table rather than on a
    // clock the registry was handed, because the claim is that it holds none.
    vi.useFakeTimers();
    const registry = new ActivityIndicatorRegistry();
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(PAST_ANY_PLAUSIBLE_DEADLINE_MS);
    expect(registry.activityIn("channel-main").agentRuns).toHaveLength(1);
  });

  it("clears on its own run's end edge", () => {
    const registry = new ActivityIndicatorRegistry();
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    registry.clearAgentActivity("run-1");
    expect(registry.activityIn("channel-main").agentRuns).toHaveLength(0);
  });

  it("negative control: another run's end edge leaves it alone", () => {
    const registry = new ActivityIndicatorRegistry();
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    registry.clearAgentActivity("run-2");
    expect(registry.activityIn("channel-main").agentRuns).toHaveLength(1);
  });

  it("shows a run only in the channel it is running in", () => {
    const registry = new ActivityIndicatorRegistry();
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-review",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(registry.activityIn("channel-main").agentRuns).toHaveLength(0);
    expect(registry.activityIn("channel-review").agentRuns).toHaveLength(1);
  });
});

describe("activity indicators — teardown", () => {
  it("drops everything and takes no note afterwards", () => {
    const registry = new ActivityIndicatorRegistry();
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });

    registry.dispose();
    registry.noteAgentActivity({
      runId: "run-2",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });

    expect(registry.activityIn("channel-main").agentRuns).toHaveLength(0);
  });
});

describe("activity indicators — the snapshot React reads", () => {
  it("returns the same value until something changes", () => {
    // Identity stability is a correctness requirement, not a saving: React's
    // external-store binding re-reads whenever the snapshot differs, so a fresh
    // array every call would never converge.
    const registry = new ActivityIndicatorRegistry();
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(registry.activityIn("channel-main")).toBe(registry.activityIn("channel-main"));
  });

  it("negative control: a change hands back a different value", () => {
    const registry = new ActivityIndicatorRegistry();
    registry.noteAgentActivity({
      runId: "run-1",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    const before = registry.activityIn("channel-main");
    registry.noteAgentActivity({
      runId: "run-2",
      channelId: "channel-main",
      since: "2026-01-01T10:00:00.000Z",
    });
    expect(registry.activityIn("channel-main")).not.toBe(before);
  });

  it("tells its listeners once per change", () => {
    const registry = new ActivityIndicatorRegistry();
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
