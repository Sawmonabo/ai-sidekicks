// `replay()` projects the owner from the bootstrap `session.created` event's `actor`, and refuses
// an event log whose bootstrap is missing or not at sequence 0, since projecting from it would
// present partial state as complete.

import { describe, expect, it } from "vitest";

import { replay } from "../session-projector.js";
import type { DaemonSessionRecord, StoredEvent } from "../types.js";
import {
  makeCreatedEvent,
  OCCURRED_AT,
  OWNER_ACTOR_ID,
  SESSION_ID,
} from "./stored-event.test-support.js";

describe("session-projector — bootstrap projection", () => {
  it("records the owner from a single session.created event", () => {
    const record: DaemonSessionRecord | null = replay([makeCreatedEvent()]);
    expect(record).not.toBeNull();
    if (record === null) return; // type guard for TS

    expect(record.sessionId).toBe(SESSION_ID);
    expect(record.createdAt).toBe(OCCURRED_AT);
    expect(record.asOfSequence).toBe(0);

    expect(record.ownerActor).toBe(OWNER_ACTOR_ID);
  });
});

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

  // A stored row can carry any sequence, so this projector check is the only guard against a log
  // that opens at sequence > 0 and hides lost or corrupted earlier events.

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
