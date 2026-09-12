// The one producer, driven over a wire the case decides.
//
// What is replaced is the WIRE and nothing else: the fold, the diff and the registry's
// one mechanism are the shipped ones, on a frozen clock. The push signal is captured
// rather than scripted so a case can say exactly when the room changed, which is the
// only way a re-read of an UNCHANGED reading — the case the diff exists for — can be
// staged at all.

import { describe, expect, it } from "vitest";

import { ConsoleRefusalError, ManualClock, REFRESH_MAX_WAIT_MS } from "../core/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import type { GrowthActivitySnapshot } from "../bridge/index.js";
import { PushDrivenRead } from "../seats/index.js";
import { ActivityFeed, ACTIVITY_FEED_ORIGIN } from "./activity-feed.js";
import { ActivityIndicatorRegistry } from "./activity-model.js";

const CHANNEL_MAIN = "channel-main";
const CHANNEL_REVIEW = "channel-review";
const RUN_REVIEW = "run-review";
const RUN_BUILD = "run-build";

/** Nothing running anywhere. */
const EMPTY: GrowthActivitySnapshot = { agentRuns: [] };

/** One run working in review, at whatever moment its publisher last said. */
function reading(since: string): GrowthActivitySnapshot {
  return { agentRuns: [{ runId: RUN_REVIEW, channelId: CHANNEL_REVIEW, since }] };
}

function feedOver(answer: () => GrowthActivitySnapshot | Error): {
  readonly feed: ActivityFeed;
  readonly registry: ActivityIndicatorRegistry;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const registry = new ActivityIndicatorRegistry();
  const read = new PushDrivenRead<GrowthActivitySnapshot>({
    clock,
    origin: ACTIVITY_FEED_ORIGIN,
    read: async () => {
      const settled = answer();
      if (settled instanceof Error) {
        throw settled;
      }
      return await Promise.resolve(settled);
    },
    subscribe: () => () => {},
  });
  return { feed: new ActivityFeed(read, registry), registry, clock };
}

/** Let the scheduler's absolute deadline fire and the read that follows it settle. */
async function settle(clock: ManualClock): Promise<void> {
  clock.advance(REFRESH_MAX_WAIT_MS);
  await crossMacrotaskBoundary();
}

describe("the activity feed — filling a registry that had no producer", () => {
  it("leaves the registry empty until the feed is started", async () => {
    const { registry, clock } = feedOver(() => reading("2026-01-01T10:05:00.000Z"));
    await settle(clock);
    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(0);
  });

  it("folds a reading into the channel the run is working in", async () => {
    const { feed, registry, clock } = feedOver(() => reading("2026-01-01T10:05:00.000Z"));
    feed.start();
    await settle(clock);
    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toEqual([
      { runId: RUN_REVIEW, channelId: CHANNEL_REVIEW, since: "2026-01-01T10:05:00.000Z" },
    ]);
    expect(registry.activityIn(CHANNEL_MAIN).agentRuns).toHaveLength(0);
  });
});

describe("the activity feed — what counts as a change", () => {
  it("applies a reading whose `since` has moved", async () => {
    let since = "2026-01-01T10:05:00.000Z";
    const { feed, registry, clock } = feedOver(() => reading(since));
    feed.start();
    await settle(clock);

    since = "2026-01-01T10:05:09.000Z";
    feed.read.refresh("user-request");
    await settle(clock);

    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns[0]?.since).toBe(since);
  });

  it("negative control: a re-read of the identical reading applies nothing", async () => {
    // Without this the case above would pass over a fold that re-noted every entry on
    // every refresh, which is the churn the diff exists to avoid — and which the
    // registry's remembered snapshot would report as a change to every reader.
    const { feed, registry, clock } = feedOver(() => reading("2026-01-01T10:05:00.000Z"));
    feed.start();
    await settle(clock);
    const before = registry.activityIn(CHANNEL_REVIEW);

    feed.read.refresh("user-request");
    await settle(clock);

    expect(registry.activityIn(CHANNEL_REVIEW)).toBe(before);
  });

  it("clears a run the room no longer carries", async () => {
    let current = reading("2026-01-01T10:05:00.000Z");
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);

    current = EMPTY;
    feed.read.refresh("user-request");
    await settle(clock);

    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(0);
  });

  it("clears the run that ended without touching the one still going", async () => {
    // The diff walks a SET, and this is the case that separates "cleared what left"
    // from "cleared everything": with one run in the room both readings look the
    // same, and a fold that blanked the room on every refresh would pass.
    const review = {
      runId: RUN_REVIEW,
      channelId: CHANNEL_REVIEW,
      since: "2026-01-01T10:05:00.000Z",
    };
    let current: GrowthActivitySnapshot = {
      agentRuns: [
        review,
        { runId: RUN_BUILD, channelId: CHANNEL_REVIEW, since: "2026-01-01T10:05:01.000Z" },
      ],
    };
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);
    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(2);

    current = { agentRuns: [review] };
    feed.read.refresh("user-request");
    await settle(clock);

    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns.map((entry) => entry.runId)).toEqual([
      RUN_REVIEW,
    ]);
  });

  it("moves a run rather than showing it in two rooms", async () => {
    let current = reading("2026-01-01T10:05:00.000Z");
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);

    current = {
      agentRuns: [
        { runId: RUN_REVIEW, channelId: CHANNEL_MAIN, since: "2026-01-01T10:05:01.000Z" },
      ],
    };
    feed.read.refresh("user-request");
    await settle(clock);

    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(0);
    expect(registry.activityIn(CHANNEL_MAIN).agentRuns).toHaveLength(1);
  });
});

describe("the activity feed — a read that stops answering", () => {
  it("clears the indicator, which has no deadline of its own", async () => {
    let current: GrowthActivitySnapshot | Error = reading("2026-01-01T10:05:00.000Z");
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);
    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(1);

    current = new ConsoleRefusalError({
      origin: ACTIVITY_FEED_ORIGIN,
      code: "read-failed",
      detail: "the activity read stopped answering",
    });
    feed.read.refresh("user-request");
    await settle(clock);

    expect(feed.read.state.kind).toBe("failed");
    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(0);
  });

  it("stops folding once the feed is disposed", async () => {
    let current = EMPTY;
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);

    feed.dispose();
    current = reading("2026-01-01T10:05:00.000Z");
    feed.read.refresh("user-request");
    await settle(clock);

    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(0);
  });
});
