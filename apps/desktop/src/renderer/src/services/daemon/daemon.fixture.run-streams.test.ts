// A narrowed run stream delivers the payload it registers, not the beat's envelope.
//
// The sibling file `bridge.test.ts` owns ROUTING — which beats reach which
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
// go through `RunStateChangeEventSchema` and `RunRolledBackEventSchema` themselves.
// Those are `.strict()`, so an envelope member leaking through fails too. A test file
// is not bundled, so it can import the schemas as values where the projector
// deliberately imports the types only.

import { describe, expect, it } from "vitest";

import { RunRolledBackEventSchema, RunStateChangeEventSchema } from "@ai-sidekicks/contracts";

import { RefusalError } from "@renderer/lib/refusal.js";
import {
  PROBE_RUN_ID,
  createFixture,
  lastScriptedBeatMs,
  runTransitionBeat,
  subscribeThroughBridge,
} from "@test/helpers/fixture-bridge.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { findScenarioContractDefects } from "@test/helpers/scenario-contract-check/contract-check.js";
import {
  RUN_QUEUE_EVENT_STREAM,
  RUN_STATE_EVENT_STREAM,
  SESSION_EVENT_STREAM,
} from "./session-event-streams.js";

/** Past the concurrent-streaming script's last beat, read off the script so it cannot go stale. */
const PAST_EVERY_BEAT_MS = lastScriptedBeatMs(CONCURRENT_STREAMING_SCENARIO) + 100;

/** The tick the probe's rollback beat falls due at. */
const ROLLBACK_BEAT_MS = lastScriptedBeatMs(CONCURRENT_STREAMING_SCENARIO) + 60;

/**
 * The concurrent-streaming scenario script plus one rollback row.
 *
 * The concurrent-streaming scenario plays run transitions and no rollback, so the state stream's second
 * arm would go untested. The added beat names a registered event type and carries the
 * members its registered PROJECTION names, so the probe is a script the daemon could
 * have produced.
 */
function scenarioWithRollbackBeat(): Scenario {
  const lastConcurrentStreamingBeat =
    CONCURRENT_STREAMING_SCENARIO.beats[CONCURRENT_STREAMING_SCENARIO.beats.length - 1];
  if (lastConcurrentStreamingBeat === undefined) {
    throw new Error(
      "the concurrent-streaming scenario plays no beats, so there is nothing to extend",
    );
  }
  const { sessionId } = lastConcurrentStreamingBeat.event;
  const nextSequence = lastConcurrentStreamingBeat.event.sequence + 1;
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id: "concurrent-streaming-stream-routing-probe",
    beats: [
      ...CONCURRENT_STREAMING_SCENARIO.beats,
      {
        atMs: ROLLBACK_BEAT_MS,
        event: {
          id: "019b79ee-0280-7ea1-8110-e5e0d1150010",
          sessionId,
          sequence: nextSequence,
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
    // The creation row is not a transition: the concurrent-streaming plays `run.queued` for every
    // run it starts, and no state precedes `queued` in the run state machine — so
    // however many runs the script carries, none of their creations reaches this
    // stream. Asserted as an absence rather than as a count, because a count would
    // have to re-derive the kind-to-state table this projection owns.
    expect(
      CONCURRENT_STREAMING_SCENARIO.beats.some((beat) => beat.event.kind === "run.queued"),
    ).toBe(true);
    expect(parsed.map((event) => event.currentState)).not.toContain("queued");
    // The first transition the script plays, member by member.
    expect(parsed[0]?.currentState).toBe("starting");
    expect(parsed[0]?.previousState).toBe("queued");
    // Sourced from the beat's own envelope, which is the only place the instant
    // lives — and not from the scenario's start, which is what a projection
    // stamping the clock it was handed would have delivered.
    const firstTransitionBeat = CONCURRENT_STREAMING_SCENARIO.beats.find(
      (beat) => beat.event.kind === "run.starting",
    );
    expect(firstTransitionBeat?.event.occurredAt).not.toBe(
      CONCURRENT_STREAMING_SCENARIO.startedAtIso,
    );
    expect(parsed[0]?.timestamp).toBe(firstTransitionBeat?.event.occurredAt);
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
    const fixture = createFixture(scenarioWithRollbackBeat());
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
    expect(parsed.sessionId).toBe(CONCURRENT_STREAMING_SCENARIO.sessionId);
    expect(RunStateChangeEventSchema.safeParse(rollback).success).toBe(false);
  });

  it("negative control: the whole-session stream still receives the envelope", () => {
    // Two things at once, and both are needed. A projector applied to every
    // subscription would break the console's one real subscriber, whose
    // registration IS the envelope; and a bridge that delivered nothing anywhere
    // would satisfy every exact-set case above by delivering the empty set.
    const probe = scenarioWithRollbackBeat();
    const fixture = createFixture(probe);
    const received = subscribeThroughBridge(fixture, SESSION_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received).toHaveLength(probe.beats.length);
    expect(received.map((envelope) => envelope.type)).toContain("run.rolled_back");
    expect(received.every((envelope) => typeof envelope.id === "string")).toBe(true);
  });

  it("negative control: a bare event-type subscriber still receives the envelope", () => {
    // The other unprojected arm. A name that is not a registered stream carries only
    // itself, and the corpus registers no projection for one — so the beat is what
    // reaches it, and a projector that fired on every name would silently rewrite
    // this subscriber's frames too.
    const fixture = createFixture();
    const received = subscribeThroughBridge(fixture, "run.starting");

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    const startingBeatCount = CONCURRENT_STREAMING_SCENARIO.beats.filter(
      (beat) => beat.event.kind === "run.starting",
    ).length;
    expect(startingBeatCount).toBeGreaterThan(0);
    expect(received.map((envelope) => envelope.type)).toStrictEqual(
      Array.from({ length: startingBeatCount }, () => "run.starting"),
    );
  });
});

/** When the single-beat queue probes below play their beat. */
const QUEUE_REFUSAL_PROBE_OCCURRED_AT = "2026-01-01T14:20:00.500Z";

const PROBE_QUEUE_ITEM_ID = "019b79ee-0280-7c11-8110-d1a4c1150092";

/** The one contract-valid queue payload the probes below vary from. */
const PROBE_QUEUE_PAYLOAD: Readonly<Record<string, unknown>> = {
  sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
  queueItemId: PROBE_QUEUE_ITEM_ID,
  state: "admitted",
};

/** A scenario playing exactly one queue beat over the given payload. */
function queueScenario(
  scenarioId: string,
  payload: Readonly<Record<string, unknown>> = PROBE_QUEUE_PAYLOAD,
): Scenario {
  return {
    ...CONCURRENT_STREAMING_SCENARIO,
    id: scenarioId,
    beats: [
      {
        atMs: 0,
        event: {
          id: "019b79ee-0280-7ea1-8110-e5e0d1150078",
          sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
          sequence: 1,
          kind: "queue_item.admitted",
          occurredAt: QUEUE_REFUSAL_PROBE_OCCURRED_AT,
          payload,
        },
      },
    ],
  };
}

describe("run streams — a beat that cannot be projected refuses, loudly", () => {
  it("refuses a transition that names no `previousState` rather than half-building one", () => {
    // The member with no substitute: the registered vocabulary has no pre-birth
    // state, so a beat that omits it cannot be projected and must not be delivered
    // without it. Delivered half-built, it renders as blank and reviews as working.
    const missingPreviousState: Scenario = {
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "run-state-missing-previous-state-probe",
      beats: [
        runTransitionBeat({
          sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
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
    }).toThrow(RefusalError);
  });

  it("refuses a queue beat that names no state rather than deriving one from its kind", () => {
    // `state` is required on every queue payload, and the strict layer registers no
    // variant for the five `queue_item.*` kinds — so nothing the contracts package
    // ships refuses a beat without it. The projection used to skip its comparison
    // when the member was absent and take the state from the KIND alone, which
    // delivered a valid-looking `QueueItemSummary` assembled from half a payload.
    const fixture = createFixture(
      queueScenario("queue-beat-stateless-probe", {
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
        queueItemId: PROBE_QUEUE_ITEM_ID,
      }),
    );
    subscribeThroughBridge<unknown>(fixture, RUN_QUEUE_EVENT_STREAM);

    expect(() => {
      fixture.engine.advance(PAST_EVERY_BEAT_MS);
    }).toThrow(/names no `state`/u);
  });

  it("refuses a beat whose kind and payload disagree about the queue state", () => {
    // The check the missing member used to skip past. `queue_item.admitted`
    // announces `admitted`; a payload saying `queued` routes by one key and renders
    // by the other, exactly as the run-state arm's disagreement does.
    const fixture = createFixture(
      queueScenario("queue-beat-state-disagreement-probe", {
        ...PROBE_QUEUE_PAYLOAD,
        state: "queued",
      }),
    );
    subscribeThroughBridge<unknown>(fixture, RUN_QUEUE_EVENT_STREAM);

    expect(() => {
      fixture.engine.advance(PAST_EVERY_BEAT_MS);
    }).toThrow(/two queue states/u);
  });

  it("refuses a beat whose kind and payload disagree about the current state", () => {
    // One beat cannot report two current states. Without this the projection would
    // take the payload's word and deliver a `run.running` frame saying `paused`,
    // which routes by one key and renders by the other.
    const disagreeing: Scenario = {
      ...CONCURRENT_STREAMING_SCENARIO,
      id: "run-state-disagreement-probe",
      beats: [
        runTransitionBeat({
          sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
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
    expect(findScenarioContractDefects([scenarioWithRollbackBeat()])).toStrictEqual([]);
  });
});
