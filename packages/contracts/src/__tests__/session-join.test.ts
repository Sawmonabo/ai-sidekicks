// Plan-001 PR #2 — Round 2 supplementary tests for SessionJoinRequest hardening
// (Findings 4 + 5) and EventCursor defense-in-depth length cap (Finding 6).
//
// These exercise wire-layer guards added in Round 2 to harden free-form string
// fields against pathological inputs (whitespace-only, NUL bytes, oversize).
// The canonical handle grammar is owned by Plan-018; these tests assert that
// obvious garbage is rejected at the wire boundary BEFORE Plan-018's
// validator runs.
//
// Round 3 (R2-1, F11) extracted the validation chain into the
// `wireFreeFormString` helper exposed via session.ts's `IdentityHandleSchema`.
// These tests intentionally still drive `SessionJoinRequestSchema` directly
// to pin the consumer-side behavior (the helper is also covered indirectly
// by the wide free-form-field coverage in `session-event.test.ts` and
// `error.test.ts`).
//
// Plan-001 file-row errata PR (2026-08-10) appended the
// `SessionJoinResponseSchema` block below: the T2.1 coverage sweep found the
// join RESPONSE arm had no direct unit coverage anywhere in this package
// (exercised only transitively through daemon IPC handler suites) — see the
// `Plan-001 §Decision Log` errata entry, same date.
import { describe, expect, it } from "vitest";

import {
  EVENT_CURSOR_MAX_LEN,
  EventCursorSchema,
  IDENTITY_HANDLE_MAX_LEN,
  SessionJoinRequestSchema,
  SessionJoinResponseSchema,
} from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PARTICIPANT_ID = "770e8400-e29b-41d4-a716-446655440002";
const MEMBERSHIP_ID = "880e8400-e29b-41d4-a716-446655440003";

const buildValidJoin = () => ({
  sessionId: SESSION_ID,
  identityHandle: "alice",
});

describe("SessionJoinRequestSchema (Round 2: identityHandle hardening)", () => {
  it("accepts a normal handle", () => {
    expect(SessionJoinRequestSchema.safeParse(buildValidJoin()).success).toBe(true);
  });

  it("accepts a handle with leading whitespace (Plan-018 owns trimming policy)", () => {
    // The wire-layer guard rejects pure-whitespace handles only; trimming
    // and stricter grammar are Plan-018 concerns. " alice" is admitted at
    // this layer to avoid pre-empting Plan-018's canonical form.
    const valid = { ...buildValidJoin(), identityHandle: " alice" };
    expect(SessionJoinRequestSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["single space", " "],
    ["multiple spaces", "   "],
    ["tabs only", "\t\t"],
    ["mixed whitespace", " \t\n "],
  ])("rejects whitespace-only handle: %s", (_label, candidate) => {
    const broken = { ...buildValidJoin(), identityHandle: candidate };
    expect(SessionJoinRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a handle containing a NUL byte", () => {
    const broken = { ...buildValidJoin(), identityHandle: "alice\u0000bob" };
    expect(SessionJoinRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized handle (defense-in-depth length cap)", () => {
    const broken = {
      ...buildValidJoin(),
      identityHandle: "x".repeat(IDENTITY_HANDLE_MAX_LEN + 1),
    };
    expect(SessionJoinRequestSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a handle at exactly the length cap (boundary)", () => {
    const valid = {
      ...buildValidJoin(),
      identityHandle: "x".repeat(IDENTITY_HANDLE_MAX_LEN),
    };
    expect(SessionJoinRequestSchema.safeParse(valid).success).toBe(true);
  });
});

describe("EventCursorSchema (Round 2: defense-in-depth length cap)", () => {
  it("accepts a non-empty opaque cursor", () => {
    expect(EventCursorSchema.safeParse("cursor-12345").success).toBe(true);
  });

  it("rejects an empty cursor", () => {
    expect(EventCursorSchema.safeParse("").success).toBe(false);
  });

  it("rejects an oversized cursor (defense-in-depth length cap)", () => {
    const broken = "x".repeat(EVENT_CURSOR_MAX_LEN + 1);
    expect(EventCursorSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a cursor at exactly the length cap (boundary)", () => {
    const valid = "x".repeat(EVENT_CURSOR_MAX_LEN);
    expect(EventCursorSchema.safeParse(valid).success).toBe(true);
  });
});

describe("SessionJoinResponseSchema (response shape)", () => {
  // Wire-shaped fixture, no per-field brand casts — safeParse accepts plain
  // UUID strings and brands them on the way out (same rationale as
  // session-create.test.ts's buildValidResponse).
  const buildValidResponse = () => ({
    sessionId: SESSION_ID,
    participantId: PARTICIPANT_ID,
    membershipId: MEMBERSHIP_ID,
    sharedMetadata: { displayName: "Alice" },
  });

  it("accepts a well-formed response and round-trips every field", () => {
    const parsed = SessionJoinResponseSchema.parse(buildValidResponse());
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.participantId).toBe(PARTICIPANT_ID);
    expect(parsed.membershipId).toBe(MEMBERSHIP_ID);
    expect(parsed.sharedMetadata).toEqual({ displayName: "Alice" });
  });

  it("accepts an empty sharedMetadata record (required key, contents free-form)", () => {
    const valid = { ...buildValidResponse(), sharedMetadata: {} };
    expect(SessionJoinResponseSchema.safeParse(valid).success).toBe(true);
  });

  it.each(["sessionId", "participantId", "membershipId", "sharedMetadata"] as const)(
    "rejects a response missing required field: %s",
    (field) => {
      const broken = { ...buildValidResponse() } as Record<string, unknown>;
      delete broken[field];
      expect(SessionJoinResponseSchema.safeParse(broken).success).toBe(false);
    },
  );

  it.each(["sessionId", "participantId", "membershipId"] as const)(
    "rejects a malformed %s (UUID guard)",
    (field) => {
      const broken = { ...buildValidResponse(), [field]: "not-a-uuid" };
      expect(SessionJoinResponseSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects a non-object sharedMetadata (string)", () => {
    const broken = { ...buildValidResponse(), sharedMetadata: "not-a-record" };
    expect(SessionJoinResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a null sharedMetadata", () => {
    const broken = { ...buildValidResponse(), sharedMetadata: null };
    expect(SessionJoinResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects unknown extra fields (.strict() guard)", () => {
    const broken = { ...buildValidResponse(), unexpected: "field" };
    expect(SessionJoinResponseSchema.safeParse(broken).success).toBe(false);
  });
});
