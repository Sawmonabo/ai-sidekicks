// D1: Single SessionCreated event yields snapshot with owner membership
// and main channel — bootstrap projection (Spec-001 AC1).
//
// Pure projector test — no SQLite, no service. Constructs a `StoredEvent`
// in-memory and calls `replay()` directly. The projector synthesizes the
// owner membership from the envelope's `actor` and the main channel from
// projector defaults; the `session.created` payload itself does not need
// to enumerate either.

import { describe, expect, it } from "vitest";

import { replay } from "../session-projector.js";
import type { StoredEvent } from "../types.js";

describe("session-projector — D1 (bootstrap projection)", () => {
  it("synthesizes owner membership and main channel from a single session.created event", () => {
    const sessionId: string = "01J0SE5510NN5J5J5J5J5J5J5J";
    const ownerParticipantId: string = "01J0PA0000NN5J5J5J5J5J5J5J";
    const occurredAt: string = "2026-04-27T12:00:00.000Z";

    const created: StoredEvent = {
      id: "01J0EV0000NN5J5J5J5J5J5J5J",
      sessionId,
      sequence: 0,
      occurredAt,
      monotonicNs: 1_000_000_000n,
      category: "session_lifecycle",
      type: "session.created",
      actor: ownerParticipantId,
      payload: { sessionId, name: "test-session" },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };

    const snapshot = replay([created]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return; // type guard for TS

    expect(snapshot.sessionId).toBe(sessionId);
    expect(snapshot.state).toBe("active");
    expect(snapshot.createdAt).toBe(occurredAt);
    expect(snapshot.asOfSequence).toBe(0);

    expect(snapshot.memberships).toHaveLength(1);
    expect(snapshot.memberships[0]).toEqual({
      participantId: ownerParticipantId,
      role: "owner",
      joinedAt: occurredAt,
    });

    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.channels[0]).toEqual({
      channelId: "main",
      name: "main",
      createdAt: occurredAt,
    });
  });

  it("returns null on an empty event list", () => {
    expect(replay([])).toBeNull();
  });

  it("rejects a first event that is not session.created", () => {
    const stranded: StoredEvent = {
      id: "01J0EV9999NN5J5J5J5J5J5J5J",
      sessionId: "01J0SE5510NN5J5J5J5J5J5J5J",
      sequence: 0,
      occurredAt: "2026-04-27T12:00:00.000Z",
      monotonicNs: 1_000_000_000n,
      category: "session_lifecycle",
      type: "membership.joined",
      actor: "01J0PA0000NN5J5J5J5J5J5J5J",
      payload: { participantId: "01J0PA1111NN5J5J5J5J5J5J5J" },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };
    expect(() => replay([stranded])).toThrow(/expected first event type 'session.created'/);
  });
});
