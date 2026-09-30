// A fixture subscription delivers only what the caller asked for. A fixture that matches the
// bridge's shape can still answer what the live bridge never would: one that ignored the event
// name would hand a `run.starting` subscriber `session.created` too. This file holds the two arms
// that deliver the beat's own envelope: a subscriber naming an event kind gets that kind, and one
// naming the whole-session stream gets every kind, replay-then-tail and in frames within the
// contract's bound. Each exact-set claim has a control, since a table that routed nothing satisfies
// both. The narrowed run streams, latency and refusals are in the sibling `daemon.fixture.*` files.
// Every case drives the real fixture bridge and engine.

import { describe, expect, it } from "vitest";

import {
  EventEnvelopeSchema,
  STREAM_FRAME_MAX_CHANGES,
  SessionStreamFrameSchema,
} from "@ai-sidekicks/contracts";

import {
  createFixture,
  lastScriptedBeatMs,
  subscribeThroughBridge,
  subscribeToSessionStream,
} from "@test/helpers/fixture-bridge.js";
import type { Scenario, ScenarioBeat } from "../../../../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { RUN_STATE_EVENT_STREAM } from "./session-event-streams.js";

/** The `session.subscribe` frame as the contract registers it, over the tolerant envelope. */
const SESSION_FRAME_SCHEMA = SessionStreamFrameSchema(EventEnvelopeSchema);

/** Past the concurrent-streaming script's last beat, read off the script so it cannot go stale. */
const PAST_EVERY_BEAT_MS = lastScriptedBeatMs(CONCURRENT_STREAMING_SCENARIO) + 100;

/** How many beats of one kind the concurrent-streaming plays, read off the script. */
function concurrentStreamingBeatCountOfKind(kind: string): number {
  return CONCURRENT_STREAMING_SCENARIO.beats.filter((beat) => beat.event.kind === kind).length;
}

describe("fixture bridge — a subscription delivers only the event it named", () => {
  it("hands a kind subscriber that kind's beats and no others", () => {
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, "run.starting");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // Every beat of that kind and nothing else, never `session.created`, which arrives first.
    // The count is read off the script because the scenario plays one run per lane.
    const startingBeatCount = concurrentStreamingBeatCountOfKind("run.starting");
    expect(startingBeatCount).toBeGreaterThan(0);
    expect(received.map((envelope) => envelope.type)).toStrictEqual(
      Array.from({ length: startingBeatCount }, () => "run.starting"),
    );
  });

  it("negative control: the session stream still receives every beat", () => {
    // Without it, a filter that delivered nothing passes the case above, and the console's real
    // subscriber names the stream.
    const fixture = createFixture();
    const received = subscribeToSessionStream(fixture);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received.events()).toHaveLength(CONCURRENT_STREAMING_SCENARIO.beats.length);
    expect(new Set(received.events().map((envelope) => envelope.type)).size).toBeGreaterThan(1);
  });

  it("delivers nothing to a subscriber whose kind the script never plays", () => {
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, "run.failed");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received).toStrictEqual([]);
  });

  it("keeps the two arms independent, so one subscription cannot feed another", () => {
    const fixture = createFixture();
    const streamed = subscribeToSessionStream(fixture);
    const requested = subscribeThroughBridge(fixture, "approval.requested");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    const requestedBeatCount = concurrentStreamingBeatCountOfKind("approval.requested");
    expect(requestedBeatCount).toBeGreaterThan(0);
    expect(streamed.events()).toHaveLength(CONCURRENT_STREAMING_SCENARIO.beats.length);
    expect(requested.map((envelope) => envelope.type)).toStrictEqual(
      Array.from({ length: requestedBeatCount }, () => "approval.requested"),
    );
  });
});

describe("fixture bridge — the whole-session stream is replay-then-tail", () => {
  /** Far enough in to have delivered part of the concurrent-streaming script and not all of it. */
  const MID_SCRIPT_MS = 100;

  it("hands a subscriber attaching mid-script the beats it missed, then tails", () => {
    const fixture = createFixture();

    fixture.engine.advance(MID_SCRIPT_MS);
    const elapsed = fixture.engine.progress.deliveredBeatCount;
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(CONCURRENT_STREAMING_SCENARIO.beats.length);

    const received = subscribeToSessionStream(fixture);
    expect(received.events()).toHaveLength(elapsed);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // Contiguous from the first log position; a subscriber handed only the tail would read every
    // position it missed as a gap.
    expect(received.events().map((envelope) => envelope.sequence)).toStrictEqual(
      CONCURRENT_STREAMING_SCENARIO.beats.map((beat) => beat.event.sequence),
    );
  });

  it("hands a subscriber attaching after completion the whole script", () => {
    const fixture = createFixture();

    fixture.engine.advance(PAST_EVERY_BEAT_MS);
    const received = subscribeToSessionStream(fixture);

    expect(received.events()).toHaveLength(CONCURRENT_STREAMING_SCENARIO.beats.length);
  });

  it("negative control: the narrowed run stream and a bare event type stay live", () => {
    // Without it, an engine that replayed to every subscriber passes the two cases above,
    // handing a run-stream subscriber frames the daemon does not send on a live stream.
    const fixture = createFixture();

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(subscribeThroughBridge(fixture, RUN_STATE_EVENT_STREAM)).toStrictEqual([]);
    expect(subscribeThroughBridge(fixture, "approval.requested")).toStrictEqual([]);
  });

  it("negative control: an early subscriber receives each beat exactly once", () => {
    // A subscriber attached before the first advance has no prefix; one handed the prefix
    // anyway would see the session twice.
    const fixture = createFixture();
    const received = subscribeToSessionStream(fixture);

    fixture.engine.advance(MID_SCRIPT_MS);
    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received.events().map((envelope) => envelope.id)).toStrictEqual(
      CONCURRENT_STREAMING_SCENARIO.beats.map((beat) => beat.event.id),
    );
  });
});

describe("fixture bridge — the whole-session stream arrives in frames", () => {
  /** One more beat than a frame carries, so a replay of them cannot fit in one. */
  const LONG_LOG_BEAT_COUNT = STREAM_FRAME_MAX_CHANGES + 1;

  /** The concurrent-streaming session, playing a log of registered beats all at time zero. */
  function scenarioWithLongLog(): Scenario {
    const beats: ScenarioBeat[] = Array.from({ length: LONG_LOG_BEAT_COUNT }, (_, index) => ({
      atMs: 0,
      event: {
        id: `019b79ee-0280-7ea1-8110-${String(index).padStart(12, "0")}`,
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        sequence: index + 1,
        kind: "run.starting",
        occurredAt: "2026-01-01T14:20:00.500Z",
      },
    }));
    return { ...CONCURRENT_STREAMING_SCENARIO, id: "long-log-framing-probe", beats };
  }

  it("replays a log longer than one frame as several frames the contract admits", () => {
    const fixture = createFixture(scenarioWithLongLog());
    fixture.engine.advance(1);

    const received = subscribeToSessionStream(fixture);

    // More than one frame, each the registered shape, and together the whole log in order.
    expect(received.frames.length).toBeGreaterThan(1);
    for (const frame of received.frames) {
      expect(SESSION_FRAME_SCHEMA.safeParse(frame).success).toBe(true);
      expect(frame.dropped).toBeUndefined();
    }
    expect(received.events().map((envelope) => envelope.sequence)).toStrictEqual(
      Array.from({ length: LONG_LOG_BEAT_COUNT }, (_, index) => index + 1),
    );
  });
});
