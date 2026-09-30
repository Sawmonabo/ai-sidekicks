// A fixture subscription delivers only what the caller asked for.
//
// The fixture is shape-identical to `PlatformBridge`, and `bridge-shape.test.ts`
// turns that into a checked claim. Shape is the cheap half. This file is one of the
// three places where a fixture that matches the contract's SHAPE can still answer
// something the live bridge never would: `daemon.subscribe` takes an event name, and
// a fixture that ignored it would hand a view subscribed to `run.starting`
// `session.created` and `approval.requested` too, each cast to the type it had asked for.
// A screenshot or an end-to-end result taken against that is a result the live bridge
// cannot produce.
//
// Two claims travel here rather than one, because a fixture can route by two
// different keys and getting either wrong is invisible on screen: a subscriber
// naming an EVENT KIND is handed that kind, and a subscriber naming the whole-session
// STREAM is handed every kind it carries. A table that routed nothing anywhere
// satisfies both exact-set claims by delivering the empty set twice, so each carries
// the control that catches it.
//
// A third claim rides here because it belongs to the same two arms: WHEN a
// subscriber attaches. `session.subscribe` is registered replay-then-tail, so one
// opened mid-scenario is handed the elapsed beats before it tails; a bare event type
// and the two narrowed run streams are live and are handed nothing they missed.
//
// And a fourth, about HOW the whole-session stream arrives: in frames, as the live
// daemon sends it, each within the contract's frame bound — so a replayed log longer
// than one frame goes out as several.
//
// This file owns the two arms that deliver the beat's own ENVELOPE — a bare event
// type, one envelope per beat, and the whole-session stream, frames of them. The two
// narrowed run streams deliver a registered projection instead, which is a different
// claim with a different failure mode, and it lives in `bridge.run-streams.test.ts`. The remaining concerns have
// their own files too: `bridge.latency.test.ts` and `bridge.refusals.test.ts`.
//
// Every case drives the REAL fixture bridge over a real scenario and the real
// engine. A hand-written stand-in for either would pass over exactly the seam
// these cases exist to hold.

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

    // A subscriber that named one of the script's kinds is handed every beat of that
    // kind and nothing else — never `session.created`, which arrives first and is
    // what an unfiltered fixture delivers into a `run.starting` handler. The count is
    // read off the script rather than written down, because the concurrent-streaming
    // scenario plays as many runs as it has lanes.
    const startingBeatCount = concurrentStreamingBeatCountOfKind("run.starting");
    expect(startingBeatCount).toBeGreaterThan(0);
    expect(received.map((envelope) => envelope.type)).toStrictEqual(
      Array.from({ length: startingBeatCount }, () => "run.starting"),
    );
  });

  it("negative control: the session stream still receives every beat", () => {
    // Without this, a filter that delivered nothing at all would pass the case
    // above — and the console's one real subscriber names the STREAM, so a
    // blanket filter would silence the whole console rather than tidy it.
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

    // Contiguous from the first log position, which is what keeps the store that
    // consumes this stream out of degradation: a subscriber handed only the tail
    // reads every position it missed as a gap.
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
    // Without this, an engine that replayed to every subscriber would pass the two
    // cases above while handing a run-stream subscriber transitions it never subscribed in
    // time for — a frame the daemon does not send on a live projection stream.
    const fixture = createFixture();

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(subscribeThroughBridge(fixture, RUN_STATE_EVENT_STREAM)).toStrictEqual([]);
    expect(subscribeThroughBridge(fixture, "approval.requested")).toStrictEqual([]);
  });

  it("negative control: an early subscriber receives each beat exactly once", () => {
    // The duplicate the replay could introduce: a subscriber attached before the
    // first advance has no prefix to be handed, and one handed the prefix anyway
    // would read as a session that happened twice.
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

    // More than one frame, each one the registered shape — within the bound, changes
    // and no frame cursor, no drop mark — and together the whole log in order.
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
