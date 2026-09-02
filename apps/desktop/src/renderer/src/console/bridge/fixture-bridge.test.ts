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
// naming an EVENT KIND is handed that kind, and a subscriber naming a registered
// STREAM is handed every kind that stream carries. A table that routed nothing
// anywhere satisfies both exact-set claims by delivering the empty set twice, so
// each carries the control that catches it.
//
// The other two concerns have their own files, one each:
// `fixture-bridge.latency.test.ts` and `fixture-bridge.refusals.test.ts`.
//
// Every case drives the REAL fixture bridge over a real scenario and the real
// engine. A hand-written stand-in for either would pass over exactly the seam
// these cases exist to hold.

import { describe, expect, it } from "vitest";

import { createFixture, subscribeThroughBridge } from "./fixture-bridge.test-support.js";
import type { ConsoleScenario } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  SESSION_EVENT_STREAM,
} from "./session-event-streams.js";

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
    expect(received.map((event) => event.kind)).toStrictEqual(["run.starting"]);
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

describe("fixture bridge — a registered stream delivers the kinds it carries", () => {
  /** The tick the probe's queue beat falls due at. Past the flagship's last. */
  const QUEUE_BEAT_MS = 440;

  /** The tick the probe's rollback beat falls due at. */
  const ROLLBACK_BEAT_MS = 460;

  /**
   * The flagship script plus one queue row and one rollback row.
   *
   * The flagship alone leaves both narrowed streams half-tested: it plays two run
   * transitions and no queue row at all, so a queue subscriber's empty result
   * would be indistinguishable from a filter that drops everything. Both added
   * beats name registered event types and carry the payload members their
   * registrations name, so the probe is a script the daemon could have produced.
   */
  function scenarioWithQueueAndRollbackBeats(): ConsoleScenario {
    const lastFlagshipBeat = FLAGSHIP_SCENARIO.beats[FLAGSHIP_SCENARIO.beats.length - 1];
    if (lastFlagshipBeat === undefined) {
      throw new Error("the flagship scenario plays no beats, so there is nothing to extend");
    }
    const { sessionId } = lastFlagshipBeat.event;
    const nextSequence = lastFlagshipBeat.event.sequence + 1;
    return {
      ...FLAGSHIP_SCENARIO,
      id: "flagship-stream-routing-probe",
      beats: [
        ...FLAGSHIP_SCENARIO.beats,
        {
          atMs: QUEUE_BEAT_MS,
          event: {
            id: "019b79ee-0280-7ea1-8110-e5e0d1150009",
            sessionId,
            sequence: nextSequence,
            kind: "queue_item.created",
            occurredAt: "2026-01-01T14:20:00.440Z",
            payload: {
              sessionId,
              queueItemId: "queue-item-stream-routing-probe",
              state: "queued",
            },
          },
        },
        {
          atMs: ROLLBACK_BEAT_MS,
          event: {
            id: "019b79ee-0280-7ea1-8110-e5e0d1150010",
            sessionId,
            sequence: nextSequence + 1,
            kind: "run.rolled_back",
            occurredAt: "2026-01-01T14:20:00.460Z",
            // The forward, non-state arm the same stream carries: no transition,
            // and the landing position the run came to rest at.
            payload: {
              sessionId,
              runId: "run-stream-routing-probe",
              runVersion: 3,
              targetPosition: 1,
            },
          },
        },
      ],
    };
  }

  it("hands the run-state stream the script's run transitions and no other kind", () => {
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, RUN_STATE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // The flagship plays five kinds and two of them are run transitions. Before
    // this table the fixture recognised one stream name, so this subscriber — the
    // one the runs surface makes — received nothing at all.
    expect(received.map((event) => event.kind)).toStrictEqual(["run.queued", "run.starting"]);
  });

  it("carries both registered arms of the run-state stream", () => {
    const fixture = createFixture(scenarioWithQueueAndRollbackBeats());
    const received = subscribeThroughBridge(fixture, RUN_STATE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received.map((event) => event.kind)).toStrictEqual([
      "run.queued",
      "run.starting",
      "run.rolled_back",
    ]);
  });

  it("hands the queue stream its own rows and no run beat", () => {
    const fixture = createFixture(scenarioWithQueueAndRollbackBeats());
    const received = subscribeThroughBridge(fixture, RUN_QUEUE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received.map((event) => event.kind)).toStrictEqual(["queue_item.created"]);
  });

  it("negative control: the whole-session stream still receives every beat of the probe", () => {
    // Without this, a table that routed nothing anywhere would satisfy both
    // exact-set cases above by delivering the empty set twice.
    const probe = scenarioWithQueueAndRollbackBeats();
    const fixture = createFixture(probe);
    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received).toHaveLength(probe.beats.length);
  });

  it("negative control: a stream name nothing registers receives nothing", () => {
    const fixture = createFixture(scenarioWithQueueAndRollbackBeats());
    const received = subscribeThroughBridge(fixture, "run.subscribeStates");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // A misspelled stream is not a stream, and it names no event type either, so
    // it matches nothing — the same silence the daemon answers with, rather than
    // the whole script a fall-through would deliver.
    expect(received).toStrictEqual([]);
  });
});
