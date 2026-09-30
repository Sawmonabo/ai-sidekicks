// One beat composes into an envelope the wire's own schema accepts. Cases drive the registered
// carrier and not a member list written beside the composer, which would agree with any composer
// that agreed with it. The round trip through the console's decode boundary is asserted elsewhere.

import { describe, expect, it } from "vitest";

import { EventEnvelopeSchema } from "@ai-sidekicks/contracts";

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";
import {
  SCENARIO_ENVELOPE_VERSION,
  composeScenarioEventEnvelope,
} from "./event-envelope.fixture.js";

const SESSION_ID = "019b79ee-0280-75e5-8510-ada11a5a99a9";
const EVENT_ID = "019b79ee-0280-7ea1-8110-e5e0d1159901";
const USER_ID = "019b79ee-0280-79a4-8110-cca0117a0110";

/** One beat in the shape a scenario author writes. */
function authoredBeat(overrides: Partial<ProjectedSessionEvent> = {}): ProjectedSessionEvent {
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
    const composed = composeScenarioEventEnvelope(authoredBeat({ actorId: USER_ID }));

    expect(EventEnvelopeSchema.safeParse(composed).success).toBe(true);
    expect(composed.type).toBe("run.running");
    expect(composed.category).toBe("run_lifecycle");
    expect(composed.actor).toBe(USER_ID);
    expect(composed.version).toBe(SCENARIO_ENVELOPE_VERSION);
  });

  it("negative control: the authoring record the composer was given does not", () => {
    // Without it, the case above passes against a composer that returns its argument unchanged.
    const beat = authoredBeat({ actorId: USER_ID });

    expect(EventEnvelopeSchema.safeParse(beat).success).toBe(false);
    expect(composeScenarioEventEnvelope(beat)).not.toHaveProperty("kind");
    expect(composeScenarioEventEnvelope(beat)).not.toHaveProperty("actorId");
  });

  it("supplies an empty payload where the beat states none, because the wire omits none", () => {
    // Spelled out: under `exactOptionalPropertyTypes` an absent member differs from
    // `undefined`, and absent is what a scenario author writes.
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
    // Absent, not present-`null`: no actor is a different claim from the system, and the wire
    // distinguishes them.
    const composed = composeScenarioEventEnvelope(authoredBeat());

    expect(composed).not.toHaveProperty("actor");
    expect(EventEnvelopeSchema.safeParse(composed).success).toBe(true);
  });

  it("composes an unregistered kind with no category, which the carrier then refuses", () => {
    // The composer substitutes nothing: a kind outside the census has no category, so a beat
    // no daemon emits is not delivered as though one did, and
    // `tests/helpers/scenario-contract-check/contract-check.ts` reports it before it ships.
    const composed = composeScenarioEventEnvelope(authoredBeat({ kind: "run.started" }));

    expect(composed).not.toHaveProperty("category");
    expect(EventEnvelopeSchema.safeParse(composed).success).toBe(false);
  });
});
