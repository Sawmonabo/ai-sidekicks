// `replay()` refuses an event log whose bootstrap is missing or not at sequence 0, since
// projecting from it would present partial state as complete.

import { describe, expect, it } from "vitest";

import { replay } from "../session-projector.js";
import type { StoredEvent } from "../types.js";

const SESSION_ID: string = "01J0SE5510NN5J5J5J5J5J5J5J";
const OWNER_ACTOR_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";
const OCCURRED_AT: string = "2026-04-27T12:00:00.000Z";

function makeCreatedEvent(): StoredEvent {
  return {
    id: "01J0EV0000NN5J5J5J5J5J5J5J",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: OCCURRED_AT,
    monotonicNs: 1_000_000_000n,
    category: "session_lifecycle",
    type: "session.created",
    actor: OWNER_ACTOR_ID,
    payload: {
      sessionId: SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444",
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: OCCURRED_AT,
      },
    },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

describe("session-projector — bootstrap refusals", () => {
  it("rejects a first event that is not session.created", () => {
    const stranded: StoredEvent = {
      id: "01J0EV9999NN5J5J5J5J5J5J5J",
      sessionId: SESSION_ID,
      sequence: 0,
      occurredAt: OCCURRED_AT,
      monotonicNs: 1_000_000_000n,
      category: "session_lifecycle",
      type: "session.activated",
      actor: OWNER_ACTOR_ID,
      payload: { sessionId: SESSION_ID },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };
    expect(() => replay([stranded])).toThrow(/expected first event type 'session.created'/);
  });

  // `SessionService.append` accepts any sequence, so this projector check is the only guard
  // against a log that opens at sequence > 0 and hides lost or corrupted earlier events.

  it("rejects a bootstrap session.created event at sequence > 0", () => {
    const nonZeroBootstrap: StoredEvent = {
      ...makeCreatedEvent(),
      sequence: 1,
    };
    expect(() => replay([nonZeroBootstrap])).toThrow(
      /bootstrap 'session\.created' must have sequence=0 \(got sequence=1\)/,
    );
  });
});
