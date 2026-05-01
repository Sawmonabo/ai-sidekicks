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

    // The main channel id is a deterministic UUIDv5 — the contracts
    // `ChannelIdSchema = z.uuid().brand<"ChannelId">()` validates this
    // shape at PR #5's mapping seam, so a non-UUID id would be rejected
    // there.
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
      type: "membership.created",
      actor: OWNER_PARTICIPANT_ID,
      payload: { participantId: SECOND_PARTICIPANT_ID, role: "collaborator" },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };
    expect(() => replay([stranded])).toThrow(/expected first event type 'session.created'/);
  });

  // -----------------------------------------------------------------------
  // P3 — replay() must reject a session.created at sequence > 0
  // -----------------------------------------------------------------------
  //
  // The bootstrap path's sequence-0 invariant must match `projectEvent`'s
  // in-stream `case "session.created"` guard — without the bootstrap-
  // path check, a log opening with `session.created` at sequence > 0
  // would be accepted as a valid bootstrap, masking lost/corrupted
  // earlier events. SessionService.append accepts arbitrary sequence
  // values today (the per-session strict-monotonicity is a producer
  // contract, not a service-layer enforcement), so this projector-side
  // assertion is the only line of defense that catches the case.

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
    // Belt-and-braces: pin a non-adjacent sequence so a regression that
    // accidentally compared `sequence < 1` (instead of `!== 0`) would
    // also surface. Picks a value that sits in the realistic per-
    // session range (well below Number.MAX_SAFE_INTEGER) so the test
    // exercises the same code path as production.
    const farFutureBootstrap: StoredEvent = {
      ...makeCreatedEvent(),
      sequence: 12345,
    };
    expect(() => replay([farFutureBootstrap])).toThrow(
      /bootstrap 'session\.created' must have sequence=0 \(got sequence=12345\)/,
    );
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

  // -----------------------------------------------------------------------
  // P1 — applyChannelCreated must accept the wire-optional `name`
  //
  // The wire schema (`channelCreatedPayloadSchema` in
  // `packages/contracts/src/event.ts`) declares
  // `name: wireFreeFormString(...).optional()` — i.e. the key may be
  // absent on a perfectly valid envelope. The daemon-side projection
  // mirrors the optionality so wire-to-daemon coercion stays identity.
  //
  // The ordering of guards in `applyChannelCreated` is also load-bearing:
  // the `alreadyExists` no-op MUST run BEFORE the optional-name validation
  // so that a duplicate-main-channel event with omitted `name` is a
  // clean idempotent no-op rather than a thrown crash on the
  // optional-field check.
  // -----------------------------------------------------------------------

  it("accepts a channel.created envelope with an omitted name (wire-optional field)", () => {
    const created: StoredEvent = makeCreatedEvent();
    const initial: DaemonSessionSnapshot | null = replay([created]);
    expect(initial).not.toBeNull();
    if (initial === null) return;

    const NEW_CHANNEL_ID: string = "01970000-0000-7000-8000-00000000ABCD";
    const namelessChannel: StoredEvent = {
      id: "01J0EV0010NN5J5J5J5J5J5J5J",
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-04-27T12:01:00.000Z",
      monotonicNs: 2_000_000_000n,
      category: "session_lifecycle",
      type: "channel.created",
      actor: null,
      // `name` deliberately omitted — wire-valid per
      // channelCreatedPayloadSchema.
      payload: { channelId: NEW_CHANNEL_ID },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };

    const after: DaemonSessionSnapshot = projectEvent(initial, namelessChannel);

    // Two channels: synthesized "main" + the newly-projected nameless one.
    expect(after.channels).toHaveLength(2);
    const projectedNew = after.channels.find((c) => c.channelId === NEW_CHANNEL_ID);
    expect(projectedNew).toBeDefined();
    if (projectedNew === undefined) return;
    // `name` is OMITTED from the projection (mirrors the wire absence)
    // — NOT coerced to null, NOT defaulted to a synthesized string.
    // Treating absent-as-absent is the contract; PR #5's IPC mapping
    // seam owns any UI-side fallback (e.g. label-by-channelId).
    expect(projectedNew.name).toBeUndefined();
    expect("name" in projectedNew).toBe(false);
    expect(after.asOfSequence).toBe(1);

    // The bootstrap-synthesized main channel's name is unaffected by the
    // new channel's omitted-name semantics.
    const main = after.channels.find((c) => c.channelId === deriveMainChannelId(SESSION_ID));
    expect(main?.name).toBe("main");
  });

  it("treats a duplicate-main-channel event with omitted name as an idempotent no-op (alreadyExists check runs before optional-name validation)", () => {
    // P1's failure mode in the original code: the validation throw at
    // `payload.name must be a non-empty string` ran BEFORE the
    // alreadyExists guard, so even a perfectly-valid duplicate
    // envelope (matching id of the bootstrap-synthesized main channel)
    // crashed projection if it omitted the wire-optional name. The
    // post-fix ordering is alreadyExists → optional-name validation,
    // which keeps duplicates a clean no-op.
    const created: StoredEvent = makeCreatedEvent();
    const expectedMainChannelId: string = deriveMainChannelId(SESSION_ID);
    const duplicateMainOmittedName: StoredEvent = {
      id: "01J0EV0011NN5J5J5J5J5J5J5J",
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-04-27T12:01:00.000Z",
      monotonicNs: 2_500_000_000n,
      category: "session_lifecycle",
      type: "channel.created",
      actor: null,
      // SAME id as the bootstrap-synthesized main channel; `name` omitted.
      payload: { channelId: expectedMainChannelId },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };

    const snapshot: DaemonSessionSnapshot | null = replay([created, duplicateMainOmittedName]);
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;

    // Still exactly one channel — the duplicate was no-op'd.
    expect(snapshot.channels).toHaveLength(1);
    expect(snapshot.channels[0]?.channelId).toBe(expectedMainChannelId);
    // The bootstrap-synthesized name survives — the duplicate envelope's
    // omitted name does NOT clear or overwrite it.
    expect(snapshot.channels[0]?.name).toBe("main");
    expect(snapshot.asOfSequence).toBe(1);
  });

  it("still rejects a channel.created envelope with a present-but-empty name", () => {
    // The optional-but-when-present-non-empty stance mirrors
    // `wireFreeFormString`'s whitespace-rejection: a present empty string
    // is a producer bug (the producer should OMIT the key, not send "").
    const created: StoredEvent = makeCreatedEvent();
    const initial: DaemonSessionSnapshot | null = replay([created]);
    expect(initial).not.toBeNull();
    if (initial === null) return;

    const NEW_CHANNEL_ID: string = "01970000-0000-7000-8000-00000000DEAD";
    const emptyNameChannel: StoredEvent = {
      id: "01J0EV0012NN5J5J5J5J5J5J5J",
      sessionId: SESSION_ID,
      sequence: 1,
      occurredAt: "2026-04-27T12:01:00.000Z",
      monotonicNs: 2_000_000_000n,
      category: "session_lifecycle",
      type: "channel.created",
      actor: null,
      payload: { channelId: NEW_CHANNEL_ID, name: "" },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };

    expect(() => projectEvent(initial, emptyNameChannel)).toThrow(
      /payload\.name must be a non-empty string when present/,
    );
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
// projectEvent — membership.created role propagation
// --------------------------------------------------------------------------
//
// The projector reads `payload.role` directly so every variant of the
// canonical `MembershipRole` union (`@ai-sidekicks/contracts`) round-
// trips through projection without daemon-side narrowing.

describe("projectEvent — membership.created", () => {
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
      type: "membership.created",
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

  it("rejects a membership.created event missing payload.role", () => {
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
      type: "membership.created",
      actor: OWNER_PARTICIPANT_ID,
      payload: { participantId: SECOND_PARTICIPANT_ID },
      correlationId: null,
      causationId: null,
      version: "1.0",
    };

    expect(() => projectEvent(initial, malformed)).toThrow(/payload\.role must be one of/);
  });
});
