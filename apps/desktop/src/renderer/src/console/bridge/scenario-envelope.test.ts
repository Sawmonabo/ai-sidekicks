// One beat composes into an envelope the wire's own schema accepts.
//
// Every case here drives the REGISTERED carrier rather than a restatement of what
// the composer is supposed to produce. A test that asserted member names against a
// list written beside them would agree with any composer that agreed with the list,
// which is the failure this seam already had once: the fixture's shape and the
// console's boundary agreed with each other and with nothing the daemon sends.
//
// WHAT IS NOT HERE. The round trip — composed envelope back through the console's
// own decode boundary — spans two families, so it lives in the architecture tier
// (`test/console/architecture/scenario-wire-truth.test.ts`), where it runs over
// every beat of every shipped scenario rather than over one written here.

import { describe, expect, it } from "vitest";

import { EventEnvelopeSchema } from "@ai-sidekicks/contracts";

import type { ConsoleSessionEvent } from "../store/index.js";
import { SCENARIO_ENVELOPE_VERSION, composeScenarioEventEnvelope } from "./scenario-envelope.js";

const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a99a9";
const EVENT_ID = "019b79ee-0280-7ea1-8110-e5e0d1159901";
const PARTICIPANT_ID = "019b79ee-0280-79a4-8110-cca0117a0110";

/** One beat in the shape a scenario author writes. */
function authoredBeat(overrides: Partial<ConsoleSessionEvent> = {}): ConsoleSessionEvent {
  return {
    id: EVENT_ID,
    sessionId: SESSION_ID,
    sequence: 3,
    kind: "run.running",
    occurredAt: "2026-01-01T14:20:00.500Z",
    payload: { runId: SESSION_ID, newState: "running" },
    ...overrides,
  };
}

describe("composeScenarioEventEnvelope — the shape the fixture delivers", () => {
  it("composes an envelope the registered carrier accepts", () => {
    const composed = composeScenarioEventEnvelope(
      authoredBeat({ actorParticipantId: PARTICIPANT_ID }),
    );

    expect(EventEnvelopeSchema.safeParse(composed).success).toBe(true);
    expect(composed.type).toBe("run.running");
    expect(composed.category).toBe("run_lifecycle");
    expect(composed.actor).toBe(PARTICIPANT_ID);
    expect(composed.version).toBe(SCENARIO_ENVELOPE_VERSION);
  });

  it("negative control: the authoring record the composer was given does not", () => {
    // Without this, the case above passes against a composer that returns its
    // argument unchanged — which is exactly what the fixture used to deliver.
    const beat = authoredBeat({ actorParticipantId: PARTICIPANT_ID });

    expect(EventEnvelopeSchema.safeParse(beat).success).toBe(false);
    expect(composeScenarioEventEnvelope(beat)).not.toHaveProperty("kind");
    expect(composeScenarioEventEnvelope(beat)).not.toHaveProperty("actorParticipantId");
  });

  it("supplies an empty payload where the beat states none, because the wire omits none", () => {
    // Spelled out rather than overridden away: `exactOptionalPropertyTypes` makes
    // "the member is absent" a different value from "the member is `undefined`",
    // and absent is the state a scenario author actually writes.
    const composed = composeScenarioEventEnvelope({
      id: EVENT_ID,
      sessionId: SESSION_ID,
      sequence: 3,
      kind: "run.running",
      occurredAt: "2026-01-01T14:20:00.500Z",
    });

    expect(composed.payload).toStrictEqual({});
    expect(EventEnvelopeSchema.safeParse(composed).success).toBe(true);
  });

  it("omits the actor where the beat attributes itself to nobody", () => {
    // Absent rather than present-`null`: a beat that names no actor is not the same
    // claim as one that names the system, and the two are wire-distinguishable.
    const composed = composeScenarioEventEnvelope(authoredBeat());

    expect(composed).not.toHaveProperty("actor");
    expect(EventEnvelopeSchema.safeParse(composed).success).toBe(true);
  });

  it("composes an unregistered kind with no category, which the carrier then refuses", () => {
    // The composer substitutes nothing. A kind the census does not register has no
    // category, and a record with none is the shape `EventEnvelopeSchema` rejects —
    // so a scenario that plays a beat no daemon emits cannot be delivered as though
    // one did, and `scenarios/wire-truth.ts` reports it by name before it ships.
    const composed = composeScenarioEventEnvelope(authoredBeat({ kind: "run.started" }));

    expect(composed).not.toHaveProperty("category");
    expect(EventEnvelopeSchema.safeParse(composed).success).toBe(false);
  });
});
