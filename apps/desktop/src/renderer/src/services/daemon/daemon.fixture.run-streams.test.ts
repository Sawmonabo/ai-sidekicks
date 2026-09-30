// A narrowed run stream delivers the payload it registers, not the beat's envelope.
// `daemon.fixture.test.ts` owns routing (which beats reach which subscription); this file owns
// shape: a `run.subscribeState` subscriber must get `RunStateChangeEvent` (no `kind`, `sequence`
// or nested `payload`, and a top-level `newState`), not the renderer-local envelope. The
// projector's own behavior is in `services/run-streams/run-stream-projection.fixture.test.ts`.
//
// Clean cases are parsed through the registered `.strict()` schemas, so a dropped required member
// or a leaked envelope member fails. A test file is not bundled, so it may import the schemas as
// values where the projector imports the types only.

import { describe, expect, it } from "vitest";

import { RunRolledBackEventSchema, RunStateChangeEventSchema } from "@ai-sidekicks/contracts";

import { RefusalError } from "@renderer/lib/refusal.js";
import {
  PROBE_RUN_ID,
  createFixture,
  lastScriptedBeatMs,
  runTransitionBeat,
  subscribeThroughBridge,
  subscribeToSessionStream,
} from "@test/helpers/fixture-bridge.js";
import type { Scenario } from "../../../../../fixtures/scenario.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../../../../fixtures/scenarios/concurrent-streaming.js";
import { findScenarioContractDefects } from "@test/helpers/scenario-contract-check/contract-check.js";
import { RUN_QUEUE_EVENT_STREAM, RUN_STATE_EVENT_STREAM } from "./session-event-streams.js";

/** Past the concurrent-streaming script's last beat, read off the script so it cannot go stale. */
const PAST_EVERY_BEAT_MS = lastScriptedBeatMs(CONCURRENT_STREAMING_SCENARIO) + 100;

/** The tick the probe's rollback beat falls due at. */
const ROLLBACK_BEAT_MS = lastScriptedBeatMs(CONCURRENT_STREAMING_SCENARIO) + 60;

/**
 * The concurrent-streaming script plus one rollback row, since the script plays no rollback and
 * the state stream's second arm would go untested. The beat is a registered type carrying the
 * members its projection names, so the probe is a script the daemon could have produced.
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
          // The non-state arm of the same stream: no transition, just the landing position.
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

    // Parsed, not spot-checked: `.strict()` fails an envelope member that survives projection.
    const parsed = received.map((delivery) => RunStateChangeEventSchema.parse(delivery));
    // A creation row is not a transition: no state precedes `queued`, so no `run.queued` beat
    // reaches this stream. Asserted as an absence, since a count would re-derive the
    // projection's kind-to-state table.
    expect(
      CONCURRENT_STREAMING_SCENARIO.beats.some((beat) => beat.event.kind === "run.queued"),
    ).toBe(true);
    expect(parsed.map((event) => event.newState)).not.toContain("queued");
    // The first transition the script plays, member by member.
    expect(parsed[0]?.newState).toBe("starting");
    expect(parsed[0]?.previousState).toBe("queued");
    // The instant comes from the beat's envelope, not the scenario's start.
    const firstTransitionBeat = CONCURRENT_STREAMING_SCENARIO.beats.find(
      (beat) => beat.event.kind === "run.starting",
    );
    expect(firstTransitionBeat?.event.occurredAt).not.toBe(
      CONCURRENT_STREAMING_SCENARIO.startedAtIso,
    );
    expect(parsed[0]?.timestamp).toBe(firstTransitionBeat?.event.occurredAt);
  });

  it("negative control: the delivered payload is not the envelope it used to be", () => {
    // The case above passes over a bridge that delivered both; this pins the envelope members
    // a subscriber would key on by mistake.
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
      expect(delivery["newState"]).toBeDefined();
    }
  });

  it("carries the rollback arm as `RunRolledBackEvent`, which is a different shape", () => {
    const fixture = createFixture(scenarioWithRollbackBeat());
    const received = subscribeThroughBridge<unknown>(fixture, RUN_STATE_EVENT_STREAM);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    // The two arms share one stream with no wire tag, so the last delivery must parse as the
    // rollback shape and the state-change schema must reject it; either alone would pass a
    // projection that built one arm for both.
    const rollback = received[received.length - 1];
    const parsed = RunRolledBackEventSchema.parse(rollback);
    expect(parsed.targetPosition).toBe(1);
    expect(parsed.runVersion).toBe(3);
    expect(parsed.sessionId).toBe(CONCURRENT_STREAMING_SCENARIO.sessionId);
    expect(RunStateChangeEventSchema.safeParse(rollback).success).toBe(false);
  });

  it("negative control: the whole-session stream still receives the envelope", () => {
    // A projector applied to every subscription would break the console's real subscriber, and
    // a bridge that delivered nothing would satisfy every exact-set case above.
    const probe = scenarioWithRollbackBeat();
    const fixture = createFixture(probe);
    const received = subscribeToSessionStream(fixture);

    fixture.engine.advance(PAST_EVERY_BEAT_MS);

    expect(received.events()).toHaveLength(probe.beats.length);
    expect(received.events().map((envelope) => envelope.type)).toContain("run.rolled_back");
    expect(received.events().every((envelope) => typeof envelope.id === "string")).toBe(true);
  });

  it("negative control: a bare event-type subscriber still receives the envelope", () => {
    // A name that is not a registered stream has no projection, so the beat reaches it; a
    // projector firing on every name would rewrite its frames too.
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
    // The vocabulary has no pre-birth state, so a beat omitting it cannot be projected and
    // must not be delivered half-built.
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
    // `state` is required on every queue payload, but the strict layer registers no variant for
    // the five `queue_item.*` kinds, so nothing in contracts refuses a beat without it.
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
    // `queue_item.admitted` announces `admitted`; a payload saying `queued` would route by
    // one key and render by the other.
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
    // One beat cannot report two current states; the projection must not take the payload's
    // word and deliver a `run.running` frame saying `paused`.
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
    // Held to the predicate every shipped scenario is held to, so the cases above concern a
    // real wire.
    expect(findScenarioContractDefects([scenarioWithRollbackBeat()])).toStrictEqual([]);
  });
});
