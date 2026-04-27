// D1: Single SessionCreated event yields snapshot with owner membership
// and main channel — bootstrap projection (Spec-001 AC1).
//
// Pure projector test — no SQLite, no service. Constructs a `StoredEvent`
// in-memory and calls `replay()` directly. The projector synthesizes the
// owner membership from the envelope's `actor` and the main channel from
// projector defaults; the `session.created` payload itself does not need
// to enumerate either.

import { describe, expect, it } from "vitest";

import { deriveMainChannelId, projectEvent, replay } from "../session-projector.js";
import type { DaemonSessionSnapshot, StoredEvent } from "../types.js";

const SESSION_ID: string = "01J0SE5510NN5J5J5J5J5J5J5J";
const OWNER_PARTICIPANT_ID: string = "01J0PA0000NN5J5J5J5J5J5J5J";
const SECOND_PARTICIPANT_ID: string = "01J0PA1111NN5J5J5J5J5J5J5J";
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
    actor: OWNER_PARTICIPANT_ID,
    payload: { sessionId: SESSION_ID, name: "test-session" },
    correlationId: null,
    causationId: null,
    version: "1.0",
  };
}

describe("session-projector — D1 (bootstrap projection)", () => {
  it("synthesizes owner membership and main channel from a single session.created event", () => {
    const snapshot: DaemonSessionSnapshot | null = replay([makeCreatedEvent()]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return; // type guard for TS

    expect(snapshot.sessionId).toBe(SESSION_ID);
    // Spec-001 line 53: a newly created session starts in `provisioning`.
    // Plan-006 will land the `session.activated` event handler that
    // transitions to `active`.
    expect(snapshot.state).toBe("provisioning");
    expect(snapshot.createdAt).toBe(OCCURRED_AT);
    expect(snapshot.asOfSequence).toBe(0);

    expect(snapshot.memberships).toHaveLength(1);
    expect(snapshot.memberships[0]).toEqual({
      participantId: OWNER_PARTICIPANT_ID,
      role: "owner",
      joinedAt: OCCURRED_AT,
    });

    // The main channel id is a deterministic UUIDv5 — the literal "main"
    // string from Round 1 would fail the contracts `ChannelIdSchema =
    // z.uuid().brand<"ChannelId">()` validation at PR #5's mapping seam.
    expect(snapshot.channels).toHaveLength(1);
    const expectedMainChannelId: string = deriveMainChannelId(SESSION_ID);
    expect(snapshot.channels[0]).toEqual({
      channelId: expectedMainChannelId,
      name: "main",
      createdAt: OCCURRED_AT,
    });
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
      category: "membership_change",
      type: "membership.joined",
      actor: OWNER_PARTICIPANT_ID,
      payload: { participantId: SECOND_PARTICIPANT_ID, role: "collaborator" },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };
    expect(() => replay([stranded])).toThrow(/expected first event type 'session.created'/);
  });
});

// --------------------------------------------------------------------------
// D5 — explicit channel.created with the synthesized main-channel id is a
// no-op (the alreadyExists guard in applyChannelCreated is load-bearing).
// --------------------------------------------------------------------------
//
// The bootstrap projection synthesizes the implicit main channel from
// `session.created` rather than waiting for an explicit `channel.created`
// envelope. This matches Plan-001 plan-line-129 D1 ("single SessionCreated
// event yields snapshot with owner membership and main channel"). Plan-006
// may later emit an explicit `channel.created` for the main channel as
// part of a real audit-log flow — when that happens, the projector MUST
// not double-create. This test pins the no-op invariant.

describe("session-projector — main-channel projection invariants", () => {
  it("treats a subsequent channel.created with the derived main-channel id as an idempotent no-op", () => {
    const created: StoredEvent = makeCreatedEvent();
    const expectedMainChannelId: string = deriveMainChannelId(SESSION_ID);

    // Construct an explicit `channel.created` envelope with the SAME id
    // the bootstrap synthesizes. The alreadyExists guard MUST swallow it.
    const explicitMain: StoredEvent = {
      id: "01J0EV0001NN5J5J5J5J5J5J5J",
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-04-27T12:00:01.000Z",
      monotonicNs: 1_500_000_000n,
      category: "session_lifecycle",
      type: "channel.created",
      actor: null,
      payload: { channelId: expectedMainChannelId, name: "main-renamed-by-explicit-event" },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };

    const snapshot: DaemonSessionSnapshot | null = replay([created, explicitMain]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    // Still exactly one channel; the explicit event's `name` is discarded
    // (deliberately — the synthesized name is canonical until Plan-006
    // makes channel.created authoritative).
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.channels[0]?.channelId).toBe(expectedMainChannelId);
    expect(snapshot.channels[0]?.name).toBe("main");
    // asOfSequence still advances to the latest event so `replay()` /
    // resume markers work correctly.
    expect(snapshot.asOfSequence).toBe(1);
  });

  it("derives the same main-channel id across calls (deterministic UUIDv5)", () => {
    const a: string = deriveMainChannelId(SESSION_ID);
    const b: string = deriveMainChannelId(SESSION_ID);
    expect(a).toBe(b);

    // RFC 9562 UUIDv5 format: 8-4-4-4-12 lowercase hex with version
    // nibble = 5 and variant bits = 10.
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // Different session id → different channel id.
    const otherSession: string = "01J0SE9999NN5J5J5J5J5J5J5J";
    expect(deriveMainChannelId(otherSession)).not.toBe(a);
  });
});

// --------------------------------------------------------------------------
// projectEvent — membership.joined role propagation
// --------------------------------------------------------------------------
//
// Round 1 silently flattened `payload.role` to "member" (a value the
// contracts enum doesn't even include). The projector now reads the role
// from the payload directly — every variant of the canonical
// `MembershipRole` union must round-trip.

describe("projectEvent — membership.joined", () => {
  it("propagates payload.role into the projection (full MembershipRole union)", () => {
    const created: StoredEvent = makeCreatedEvent();
    const initial: DaemonSessionSnapshot | null = replay([created]);
    expect(initial).not.toBeNull();
    if (initial === null) return;

    const collaboratorJoined: StoredEvent = {
      id: "01J0EV0002NN5J5J5J5J5J5J5J",
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-04-27T12:01:00.000Z",
      monotonicNs: 2_000_000_000n,
      category: "membership_change",
      type: "membership.joined",
      actor: OWNER_PARTICIPANT_ID,
      payload: { participantId: SECOND_PARTICIPANT_ID, role: "collaborator" },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };

    const after: DaemonSessionSnapshot = projectEvent(initial, collaboratorJoined);
    expect(after.memberships).toHaveLength(2);
    expect(after.memberships[1]).toEqual({
      participantId: SECOND_PARTICIPANT_ID,
      role: "collaborator",
      joinedAt: "2026-04-27T12:01:00.000Z",
    });
  });

  it("rejects a membership.joined event missing payload.role", () => {
    const created: StoredEvent = makeCreatedEvent();
    const initial: DaemonSessionSnapshot | null = replay([created]);
    expect(initial).not.toBeNull();
    if (initial === null) return;

    const malformed: StoredEvent = {
      id: "01J0EV0003NN5J5J5J5J5J5J5J",
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-04-27T12:01:00.000Z",
      monotonicNs: 2_000_000_000n,
      category: "membership_change",
      type: "membership.joined",
      actor: OWNER_PARTICIPANT_ID,
      payload: { participantId: SECOND_PARTICIPANT_ID },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };

    expect(() => projectEvent(initial, malformed)).toThrow(/payload\.role must be one of/);
  });
});
