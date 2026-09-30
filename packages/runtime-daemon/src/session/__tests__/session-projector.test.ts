// Pure projector tests (no SQLite, no service): `replay()` over in-memory events. The owner
// is read off the envelope's `actor`; the `session.created` payload does not name it.

import { describe, expect, it } from "vitest";

import { replay } from "../session-projector.js";
import type { DaemonSessionSnapshot, StoredEvent } from "../types.js";

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

describe("session-projector — bootstrap projection", () => {
  it("records the owner from a single session.created event", () => {
    const snapshot: DaemonSessionSnapshot | null = replay([makeCreatedEvent()]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return; // type guard for TS

    expect(snapshot.sessionId).toBe(SESSION_ID);
    expect(snapshot.state).toBe("provisioning");
    expect(snapshot.createdAt).toBe(OCCURRED_AT);
    expect(snapshot.asOfSequence).toBe(0);

    expect(snapshot.ownerActor).toBe(OWNER_ACTOR_ID);
  });

  it("lets a later event advance asOfSequence and nothing else", () => {
    // An event the projector does not fold contributes no field to the snapshot.
    const snapshot: DaemonSessionSnapshot | null = replay([
      makeCreatedEvent(),
      {
        ...makeCreatedEvent(),
        id: "01J0EV0001NN5J5J5J5J5J5J5J",
        sequence: 1,
        category: "assistant_output",
        type: "assistant.message",
        payload: { text: "hello" },
      },
    ]);
    expect(snapshot).toStrictEqual({ ...replay([makeCreatedEvent()]), asOfSequence: 1 });
  });

  it("returns null on an empty event list", () => {
    expect(replay([])).toBeNull();
  });

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

  it("reports ownerActor as null when the bootstrap envelope names no actor", () => {
    // `actor: null` is legal, so a system-emitted bootstrap names nobody; the projector reports
    // that rather than inventing an owner.
    const systemEmitted: StoredEvent = { ...makeCreatedEvent(), actor: null };
    const snapshot: DaemonSessionSnapshot | null = replay([systemEmitted]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    expect(snapshot.ownerActor).toBeNull();
  });

  it("normalizes an empty-string actor to a null ownerActor", () => {
    // An empty owner is an absent owner; collapsing the two spares readers checking both.
    const blankActor: StoredEvent = { ...makeCreatedEvent(), actor: "" };
    const snapshot: DaemonSessionSnapshot | null = replay([blankActor]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    expect(snapshot.ownerActor).toBeNull();
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

  it("rejects a bootstrap session.created event at a far-future sequence (>0 covers the whole non-zero domain)", () => {
    // A non-adjacent sequence also catches a regression that compares `sequence < 1` instead of
    // `!== 0`.
    const farFutureBootstrap: StoredEvent = {
      ...makeCreatedEvent(),
      sequence: 12345,
    };
    expect(() => replay([farFutureBootstrap])).toThrow(
      /bootstrap 'session\.created' must have sequence=0 \(got sequence=12345\)/,
    );
  });
});
