import { describe, expect, it } from "vitest";

import {
  COMPOSING_RECEIVED_STALE_MS,
  ConsoleRefusalError,
  ManualClock,
  REFRESH_MAX_WAIT_MS,
} from "../core/index.js";
import { crossMacrotaskBoundary } from "../core/macrotask-boundary.test-support.js";
import type { GrowthActivitySnapshot } from "../bridge/index.js";
import { PushDrivenRead } from "../seats/index.js";
import { ActivityFeed, ACTIVITY_FEED_ORIGIN } from "./activity-feed.js";
import { ActivityIndicatorRegistry } from "./activity-model.js";

const CHANNEL_MAIN = "channel-main";
const CHANNEL_REVIEW = "channel-review";
const PARTICIPANT_PRIYA = "participant-priya";
const PARTICIPANT_TOMAS = "participant-tomas";
const RUN_ID = "run-peer";

const EMPTY: GrowthActivitySnapshot = { composing: [], agentRuns: [] };

/** Priya typing in the bootstrap channel, and one peer run working in review. */
function reading(since: string): GrowthActivitySnapshot {
  return {
    composing: [{ participantId: PARTICIPANT_PRIYA, channelId: CHANNEL_MAIN, since }],
    agentRuns: [{ runId: RUN_ID, channelId: CHANNEL_REVIEW, since: "2026-01-01T10:04:30.000Z" }],
  };
}

/**
 * The real feed and the real registry, over a read whose answer the case decides.
 *
 * What is replaced is the WIRE and nothing else: the fold, the diff, the registry's
 * two mechanisms and its timers are all the shipped ones, driven on a frozen clock.
 * The push signal is captured rather than scripted so a case can say exactly when the
 * room changed, which is the only way a re-read of an UNCHANGED reading — the case
 * the diff exists for — can be staged at all.
 */
function feedOver(answer: () => GrowthActivitySnapshot | Error): {
  readonly feed: ActivityFeed;
  readonly registry: ActivityIndicatorRegistry;
  readonly clock: ManualClock;
  readonly signal: () => void;
} {
  const clock = new ManualClock();
  const registry = new ActivityIndicatorRegistry(clock);
  let onChangeSignal = (): void => {};
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
    subscribe: (handler) => {
      onChangeSignal = handler;
      return () => {
        onChangeSignal = () => {};
      };
    },
  });
  return {
    feed: new ActivityFeed(read, registry),
    registry,
    clock,
    signal: () => onChangeSignal(),
  };
}

/**
 * How long after the first reading the two refresh cases push again.
 *
 * Comfortably inside {@link COMPOSING_RECEIVED_STALE_MS} so the re-read is not itself
 * the thing that expires the indicator, and comfortably past the scheduler's own
 * window so the push produces a read rather than joining the first one's burst.
 */
const MID_WINDOW_MS = 5_000;

/** Let the scheduler's absolute deadline fire and the read that follows it settle. */
async function settle(clock: ManualClock): Promise<void> {
  clock.advance(REFRESH_MAX_WAIT_MS);
  await crossMacrotaskBoundary();
}

describe("the activity feed — filling a registry that had no producer", () => {
  it("leaves the registry empty until the feed is started", async () => {
    const { registry, clock } = feedOver(() => reading("2026-01-01T10:05:00.000Z"));
    await settle(clock);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toHaveLength(0);
  });

  it("folds a reading into the composing and agent indicators", async () => {
    const { feed, registry, clock } = feedOver(() => reading("2026-01-01T10:05:00.000Z"));
    feed.start();
    await settle(clock);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toEqual([
      {
        participantId: PARTICIPANT_PRIYA,
        channelId: CHANNEL_MAIN,
        since: "2026-01-01T10:05:00.000Z",
      },
    ]);
    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(1);
    expect(registry.composingChannelFor(PARTICIPANT_PRIYA)).toBe(CHANNEL_MAIN);
  });
});

describe("the activity feed — what counts as a refresh", () => {
  it("lets an indicator expire when a re-read carries the same reading", async () => {
    const { feed, registry, clock } = feedOver(() => reading("2026-01-01T10:05:00.000Z"));
    feed.start();
    await settle(clock);
    // A push, answered with the IDENTICAL reading: the publisher has not refreshed,
    // so neither may the receiver's clear — which is what makes the ten-second bound
    // a bound rather than a value the fold keeps resetting. The re-read lands well
    // inside that bound, so what expires the indicator is the ORIGINAL note's own
    // deadline and nothing else.
    clock.advance(MID_WINDOW_MS);
    feed.read.refresh("participant-request");
    await settle(clock);
    clock.advance(COMPOSING_RECEIVED_STALE_MS - 1);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toHaveLength(0);
  });

  it("keeps an indicator alive when the re-read carries a moved `since`", async () => {
    let since = "2026-01-01T10:05:00.000Z";
    const { feed, registry, clock } = feedOver(() => reading(since));
    feed.start();
    await settle(clock);
    clock.advance(MID_WINDOW_MS);
    // The one difference from the case above, and the whole claim: a publisher that
    // refreshed moves its `since`, and that is what re-arms the clear.
    since = "2026-01-01T10:05:09.000Z";
    feed.read.refresh("participant-request");
    await settle(clock);
    clock.advance(COMPOSING_RECEIVED_STALE_MS - 1);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toHaveLength(1);
  });

  it("clears a reading the room no longer carries", async () => {
    let current = reading("2026-01-01T10:05:00.000Z");
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);
    current = EMPTY;
    feed.read.refresh("participant-request");
    await settle(clock);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toHaveLength(0);
    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(0);
  });

  it("clears the composer who left without touching the one who stayed", async () => {
    // The diff walks a SET, and this is the case that separates "cleared what left"
    // from "cleared everything": with one composer in the room both readings look
    // the same, and a fold that blanked the room on every refresh would pass.
    const priya = {
      participantId: PARTICIPANT_PRIYA,
      channelId: CHANNEL_MAIN,
      since: "2026-01-01T10:05:00.000Z",
    };
    let current: GrowthActivitySnapshot = {
      composing: [
        priya,
        {
          participantId: PARTICIPANT_TOMAS,
          channelId: CHANNEL_MAIN,
          since: "2026-01-01T10:05:01.000Z",
        },
      ],
      agentRuns: [],
    };
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toHaveLength(2);

    current = { composing: [priya], agentRuns: [] };
    feed.read.refresh("participant-request");
    await settle(clock);
    expect(registry.activityIn(CHANNEL_MAIN).composing.map((entry) => entry.participantId)).toEqual(
      [PARTICIPANT_PRIYA],
    );
  });

  it("moves a composer rather than showing them in two rooms", async () => {
    let current = reading("2026-01-01T10:05:00.000Z");
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);
    current = {
      composing: [
        {
          participantId: PARTICIPANT_PRIYA,
          channelId: CHANNEL_REVIEW,
          since: "2026-01-01T10:05:01.000Z",
        },
      ],
      agentRuns: [],
    };
    feed.read.refresh("participant-request");
    await settle(clock);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toHaveLength(0);
    expect(registry.activityIn(CHANNEL_REVIEW).composing).toHaveLength(1);
  });
});

describe("the activity feed — a read that stops answering", () => {
  it("clears the agent indicator, which has no deadline of its own", async () => {
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
    feed.read.refresh("participant-request");
    await settle(clock);
    expect(feed.read.state.kind).toBe("failed");
    expect(registry.activityIn(CHANNEL_REVIEW).agentRuns).toHaveLength(0);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toHaveLength(0);
  });

  it("stops folding once the feed is disposed", async () => {
    let current = EMPTY;
    const { feed, registry, clock } = feedOver(() => current);
    feed.start();
    await settle(clock);
    feed.dispose();
    current = reading("2026-01-01T10:05:00.000Z");
    feed.read.refresh("participant-request");
    await settle(clock);
    expect(registry.activityIn(CHANNEL_MAIN).composing).toHaveLength(0);
  });
});
