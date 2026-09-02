// A narrowed run stream delivers the payload it registers, not the beat's envelope.
//
// The sibling file `fixture-bridge.test.ts` owns ROUTING — which beats reach which
// subscription. This one owns SHAPE, and the two fail differently: routing is wrong
// when a surface receives a frame the daemon would not have sent it, and shape is
// wrong when it receives the right frame in a form the daemon never sends.
//
// The defect: the fixture handed every subscriber the renderer-local envelope, so a
// runs surface subscribed to `run.subscribeState` received `{id, sessionId, sequence,
// kind, occurredAt, payload}` where the wire sends `RunStateChangeEvent` — no `kind`,
// no `sequence`, no nested `payload`, and `currentState` where the envelope has
// `payload.newState`. Nothing rendered differently, because nothing reads those
// members yet. It will.
//
// The projector's OWN behaviour — which subscriptions it answers for at all, and
// which optional members it carries — is a different subject with a different
// failure, and lives beside the module in `run-stream-projection.test.ts`.
//
// EVERY CLEAN CASE IS PARSED THROUGH THE REGISTERED SCHEMA. A hand-written assertion
// on a few members would pass over a projection that dropped a required one, which is
// exactly the half-built shape the refusal arm exists to prevent — so the projections
// go through `RunStateChangeEventSchema`, `RunRolledBackEventSchema`, and
// `QueueItemSummarySchema` themselves. Those are `.strict()`, so an envelope member
// leaking through fails too. A test file is not bundled, so it can import the schemas
// as values where the projector deliberately imports the types only.

import { describe, expect, it } from "vitest";

import {
  QueueItemSummarySchema,
  RunRolledBackEventSchema,
  RunStateChangeEventSchema,
} from "@ai-sidekicks/contracts";

import { ConsoleRefusalError } from "../core/index.js";
import {
  PROBE_RUN_ID,
  createFixture,
  runTransitionBeat,
  subscribeThroughBridge,
} from "./fixture-bridge.test-support.js";
import type { ConsoleScenario } from "./scenario.js";
import { FLAGSHIP_SCENARIO } from "./scenarios/flagship.js";
import { findScenarioWireTruthDefects } from "./scenarios/wire-truth.js";
import {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  SESSION_EVENT_STREAM,
} from "./session-event-streams.js";

/** Past the flagship script's last beat, which is at 400 ms. */
const PAST_EVERY_BEAT_MS = 500;

/** The tick the probe's queue beat falls due at. Past the flagship's last. */
const QUEUE_BEAT_MS = 440;

/** The tick the probe's rollback beat falls due at. */
const ROLLBACK_BEAT_MS = 460;

const PROBE_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1150092";

/**
 * The flagship script plus one queue row and one rollback row.
 *
 * The flagship alone leaves both narrowed streams half-tested: it plays two run
 * transitions and no queue row at all, so a queue subscriber's empty result would be
 * indistinguishable from a filter that drops everything. Both added beats name
 * registered event types and carry the members their registered PROJECTIONS name, so
 * the probe is a script the daemon could have produced and a stream the fixture can
 * actually build a payload for.
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
          // `priority` is on the beat because `QueueItemSummary` carries queue-ROW
          // state the registered event payload does not, and the fixture's only
          // channel to a row is the beat it plays.
          payload: {
            sessionId,
            queueItemId: PROBE_QUEUE_ITEM_ID,
            state: "queued",
            priority: 0,
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
          // The forward, non-state arm the same stream carries: no transition, and
          // the landing position the run came to rest at.
          payload: {
            sessionId,
            runId: PROBE_RUN_ID,
            runVersion: 3,
            targetPosition: 1,
          },
        },
      },
    ],
  };
}

describe("run streams — the registered payload reaches the subscriber", () => {
  it("hands the state stream `RunStateChangeEvent`s the registered schema accepts", () => {
    const fixture = createFixture();
    const received = subscribeThroughBridge<unknown>(fixture, RUN_STATE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // Parsed, not spot-checked. `.strict()` means an envelope member surviving the
    // projection fails here, and a missing required member fails here too.
    const parsed = received.map((delivery) => RunStateChangeEventSchema.parse(delivery));
    expect(parsed.map((event) => event.currentState)).toStrictEqual(["queued", "starting"]);
    expect(parsed.map((event) => event.previousState)).toStrictEqual(["queued", "queued"]);
    // Sourced from the beat's envelope, which is the only place the instant lives.
    expect(parsed.map((event) => event.timestamp)).toStrictEqual([
      "2026-01-01T14:20:00.320Z",
      "2026-01-01T14:20:00.400Z",
    ]);
  });

  it("negative control: the delivered payload is not the envelope it used to be", () => {
    // The case above would pass over a bridge that delivered BOTH — so this pins the
    // members the envelope has and the projection must not: a `kind`, a `sequence`,
    // and a nested `payload` are what a surface would have keyed on by mistake.
    const fixture = createFixture();
    const received = subscribeThroughBridge<Readonly<Record<string, unknown>>>(
      fixture,
      RUN_STATE_EVENT_STREAM,
    );

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received.length).toBeGreaterThan(0);
    for (const delivery of received) {
      expect(delivery["kind"]).toBeUndefined();
      expect(delivery["sequence"]).toBeUndefined();
      expect(delivery["payload"]).toBeUndefined();
      expect(delivery["currentState"]).toBeDefined();
    }
  });

  it("carries the rollback arm as `RunRolledBackEvent`, which is a different shape", () => {
    const fixture = createFixture(scenarioWithQueueAndRollbackBeats());
    const received = subscribeThroughBridge<unknown>(fixture, RUN_STATE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // The two arms share one stream with no wire tag and stay unambiguous
    // STRUCTURALLY, so the last delivery is asked to be the rollback shape and the
    // state-change schema is asked to REJECT it. Either alone would pass over a
    // projection that built one arm for both kinds.
    const rollback = received[received.length - 1];
    const parsed = RunRolledBackEventSchema.parse(rollback);
    expect(parsed.targetPosition).toBe(1);
    expect(parsed.runVersion).toBe(3);
    expect(parsed.sessionId).toBe(FLAGSHIP_SCENARIO.sessionId);
    expect(RunStateChangeEventSchema.safeParse(rollback).success).toBe(false);
  });

  it("hands the queue stream a `QueueItemSummary` built from the beat", () => {
    const fixture = createFixture(scenarioWithQueueAndRollbackBeats());
    const received = subscribeThroughBridge<unknown>(fixture, RUN_QUEUE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received).toHaveLength(1);
    const summary = QueueItemSummarySchema.parse(received[0]);
    expect(summary.id).toBe(PROBE_QUEUE_ITEM_ID);
    // The state comes from the beat's own KIND through the same table that routed
    // it here — `queue_item.created` announces `queued`, which is the one row where
    // the name and the state it announces are different strings.
    expect(summary.state).toBe("queued");
    expect(summary.createdAt).toBe("2026-01-01T14:20:00.440Z");
    expect(summary.updatedAt).toBe("2026-01-01T14:20:00.440Z");
  });

  it("negative control: the whole-session stream still receives the envelope", () => {
    // Two things at once, and both are needed. A projector applied to every
    // subscription would break the console's one real subscriber, whose
    // registration IS the envelope; and a bridge that delivered nothing anywhere
    // would satisfy every exact-set case above by delivering the empty set.
    const probe = scenarioWithQueueAndRollbackBeats();
    const fixture = createFixture(probe);
    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received).toHaveLength(probe.beats.length);
    expect(received.map((event) => event.kind)).toContain("run.rolled_back");
    expect(received.every((event) => typeof event.id === "string")).toBe(true);
  });

  it("negative control: a bare event-type subscriber still receives the envelope", () => {
    // The other unprojected arm. A name that is not a registered stream carries only
    // itself, and the corpus registers no projection for one — so the beat is what
    // reaches it, and a projector that fired on every name would silently rewrite
    // this subscriber's frames too.
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, "run.starting");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received.map((event) => event.kind)).toStrictEqual(["run.starting"]);
  });
});

describe("run streams — a beat that cannot be projected refuses, loudly", () => {
  it("refuses a transition that names no `previousState` rather than half-building one", () => {
    // The member with no substitute: the registered vocabulary has no pre-birth
    // state, so a beat that omits it cannot be projected and must not be delivered
    // without it. Delivered half-built, it renders as blank and reviews as working.
    const missingPreviousState: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "run-state-missing-previous-state-probe",
      beats: [
        runTransitionBeat({
          sessionId: FLAGSHIP_SCENARIO.sessionId,
          runId: PROBE_RUN_ID,
          runVersion: 4,
          newState: "running",
        }),
      ],
    };
    const fixture = createFixture(missingPreviousState);
    subscribeThroughBridge<unknown>(fixture, RUN_STATE_EVENT_STREAM);

    expect(() => {
      fixture.engine.advance(PAST_EVERY_BEAT_MS);
    }).toThrow(ConsoleRefusalError);
  });

  it("names the beat and the stream in the refusal, so an author can find it", () => {
    const missingPriority: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "queue-missing-priority-probe",
      beats: [
        {
          atMs: 0,
          event: {
            id: "019b79ee-0280-7ea1-8110-e5e0d1150078",
            sessionId: FLAGSHIP_SCENARIO.sessionId,
            sequence: 1,
            kind: "queue_item.admitted",
            occurredAt: "2026-01-01T14:20:00.500Z",
            payload: {
              sessionId: FLAGSHIP_SCENARIO.sessionId,
              queueItemId: PROBE_QUEUE_ITEM_ID,
              state: "admitted",
            },
          },
        },
      ],
    };
    const fixture = createFixture(missingPriority);
    subscribeThroughBridge<unknown>(fixture, RUN_QUEUE_EVENT_STREAM);

    expect(() => {
      fixture.engine.advance(PAST_EVERY_BEAT_MS);
    }).toThrow(/queue_item\.admitted[\s\S]*priority/u);
  });

  it("negative control: the same beat carrying every member is delivered", () => {
    // Without it, a projector that refused everything would pass both cases above —
    // and a stream that refuses every beat is indistinguishable, from the surface,
    // from one that has nothing to say.
    const admitted: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "queue-admitted-complete-probe",
      beats: [
        {
          atMs: 0,
          event: {
            id: "019b79ee-0280-7ea1-8110-e5e0d1150079",
            sessionId: FLAGSHIP_SCENARIO.sessionId,
            sequence: 1,
            kind: "queue_item.admitted",
            occurredAt: "2026-01-01T14:20:00.500Z",
            payload: {
              sessionId: FLAGSHIP_SCENARIO.sessionId,
              queueItemId: PROBE_QUEUE_ITEM_ID,
              state: "admitted",
              priority: 2,
              createdAt: "2026-01-01T14:20:00.440Z",
            },
          },
        },
      ],
    };
    const fixture = createFixture(admitted);
    const received = subscribeThroughBridge<unknown>(fixture, RUN_QUEUE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    const summary = QueueItemSummarySchema.parse(received[0]);
    expect(summary.state).toBe("admitted");
    // A row that is not the birth row takes its `createdAt` from the beat, and only
    // the birth row may take the beat's own instant for it.
    expect(summary.createdAt).toBe("2026-01-01T14:20:00.440Z");
    expect(summary.updatedAt).toBe("2026-01-01T14:20:00.500Z");
  });

  it("refuses a beat whose kind and payload disagree about the current state", () => {
    // One beat cannot report two current states. Without this the projection would
    // take the payload's word and deliver a `run.running` frame saying `paused`,
    // which routes by one key and renders by the other.
    const disagreeing: ConsoleScenario = {
      ...FLAGSHIP_SCENARIO,
      id: "run-state-disagreement-probe",
      beats: [
        runTransitionBeat({
          sessionId: FLAGSHIP_SCENARIO.sessionId,
          runId: PROBE_RUN_ID,
          runVersion: 4,
          previousState: "starting",
          newState: "paused",
        }),
      ],
    };
    const fixture = createFixture(disagreeing);
    subscribeThroughBridge<unknown>(fixture, RUN_STATE_EVENT_STREAM);

    expect(() => {
      fixture.engine.advance(PAST_EVERY_BEAT_MS);
    }).toThrow(/two current states/u);
  });
});

describe("run streams — the probe is a script the daemon could have produced", () => {
  it("plays only registered types carrying payloads the strict layer accepts", () => {
    // Held to the same predicate every shipped scenario is held to, so the cases
    // above are about a real wire rather than a plausible-looking invention.
    expect(findScenarioWireTruthDefects([scenarioWithQueueAndRollbackBeats()])).toStrictEqual([]);
  });
});
