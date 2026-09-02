// A fixture subscription delivers only what the caller asked for.
//
// `Spec-023 §Console Design (Meridian)` §The fixture bridge makes the fixture
// shape-identical to `SidekicksBridge`, and I-023-13 turns that into a checked
// claim. Shape is the cheap half. This file is one of the three places where a
// fixture that matched the contract's SHAPE was still answering something the live
// bridge never would: `daemon.subscribe` takes an event name and the fixture
// ignored it, so a surface subscribed to `run.starting` was handed
// `session.created` and `membership.created` too, each cast to the type it had
// asked for. A screenshot or an end-to-end result taken against that is a result
// the live bridge cannot produce.
//
// Two claims travel here rather than one, because a fixture can route by two
// different keys and getting either wrong is invisible in a surface: a subscriber
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
// This file owns the two arms that deliver the beat's own ENVELOPE — a bare event
// type and the whole-session stream. The two narrowed run streams deliver a
// registered projection instead, which is a different claim with a different failure
// mode, and it lives in `fixture-bridge.run-streams.test.ts`. The remaining concerns
// have their own files too: `fixture-bridge.latency.test.ts` and
// `fixture-bridge.refusals.test.ts`.
//
// Every case drives the REAL fixture bridge over a real scenario and the real
// engine. A hand-written stand-in for either would pass over exactly the seam
// these cases exist to hold.

import { describe, expect, it } from "vitest";

import { createFixture, subscribeThroughBridge } from "./fixture-bridge.test-support.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { RUN_STATE_EVENT_STREAM, SESSION_EVENT_STREAM } from "./session-event-streams.js";

/** Past the flagship script's last beat, which is at 400 ms. */
const PAST_EVERY_BEAT_MS = 500;

describe("fixture bridge — a subscription delivers only the event it named", () => {
  it("hands a kind subscriber that kind's beats and no others", () => {
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, "run.starting");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // The flagship script carries five kinds. A subscriber that named one of them
    // is handed one of them — never `session.created`, which arrives first and is
    // what an unfiltered fixture delivers into a `run.starting` handler.
    expect(received.map((envelope) => envelope.type)).toStrictEqual(["run.starting"]);
  });

  it("negative control: the session stream still receives every beat", () => {
    // Without this, a filter that delivered nothing at all would pass the case
    // above — and the console's one real subscriber names the STREAM, so a
    // blanket filter would silence the whole console rather than tidy it.
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received).toHaveLength(FLAGSHIP_SCENARIO.beats.length);
    expect(new Set(received.map((envelope) => envelope.type)).size).toBeGreaterThan(1);
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
    expect(attached.map((envelope) => envelope.type)).toStrictEqual([
      "agent.attached",
      "agent.attached",
      "agent.attached",
      "agent.attached",
    ]);
  });
});

describe("fixture bridge — the whole-session stream is replay-then-tail", () => {
  /** Far enough in to have delivered part of the flagship script and not all of it. */
  const MID_SCRIPT_MS = 100;

  it("hands a subscriber attaching mid-script the beats it missed, then tails", () => {
    const fixture = createFixture();

    fixture.engine.advance(MID_SCRIPT_MS);
    const elapsed = fixture.engine.progress.deliveredBeatCount;
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(FLAGSHIP_SCENARIO.beats.length);

    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);
    expect(received).toHaveLength(elapsed);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // Contiguous from the first log position, which is what keeps the store that
    // consumes this stream out of degradation: a subscriber handed only the tail
    // reads every position it missed as a gap.
    expect(received.map((envelope) => envelope.sequence)).toStrictEqual(
      FLAGSHIP_SCENARIO.beats.map((beat) => beat.event.sequence),
    );
  });

  it("hands a subscriber attaching after completion the whole script", () => {
    const fixture = createFixture();

    fixture.engine.advance(PAST_EVERY_BEAT_MS);
    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    expect(received).toHaveLength(FLAGSHIP_SCENARIO.beats.length);
  });

  it("negative control: the narrowed run stream and a bare event type stay live", () => {
    // Without this, an engine that replayed to every subscriber would pass the two
    // cases above while handing a runs surface transitions it never subscribed in
    // time for — a frame the daemon does not send on a live projection stream.
    const fixture = createFixture();

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(subscribeThroughBridge(fixture, RUN_STATE_EVENT_STREAM)).toStrictEqual([]);
    expect(subscribeThroughBridge(fixture, "agent.attached")).toStrictEqual([]);
  });

  it("negative control: an early subscriber receives each beat exactly once", () => {
    // The duplicate the replay could introduce: a subscriber attached before the
    // first advance has no prefix to be handed, and one handed the prefix anyway
    // would read as a session that happened twice.
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    fixture.engine.advance(MID_SCRIPT_MS);
    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received.map((envelope) => envelope.id)).toStrictEqual(
      FLAGSHIP_SCENARIO.beats.map((beat) => beat.event.id),
    );
  });
});
