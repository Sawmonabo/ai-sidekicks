// Plan-002 Phase 1 T1.1 — invite contract schema tests.
//
// Backstops the two acceptance criteria + spec_coverage rows the task
// implements:
//   • C1 — Spec-002 line 80: `InviteCreate` requires `{sessionId, inviter,
//          joinMode, expiresAt}`. Omission of any field rejects.
//   • C2 — Spec-002 line 43: invite lifecycle states are EXACTLY
//          `{pending, accepted, revoked, expired}`. `"declined"` is NOT a
//          valid V1 state (declining is implicit; no explicit `declined`).
//
// Also pins the `InviteRevoke` request shape from Spec-002 line 82
// (`{sessionId: SessionId, inviteId: InviteId, reason?: string}` — exact
// shape, `.strict()` rejects extraneous keys).
//
// Coverage shape mirrors session-create.test.ts (parametrized
// missing-field rejection + enum-value rejection + composability spot-checks
// + .strict() guard).
import { describe, expect, it } from "vitest";

import {
  InviteAcceptSchema,
  InviteCreateSchema,
  InviteIdSchema,
  InviteRevokeSchema,
  InviteStateSchema,
  INVITE_REVOKE_REASON_MAX_LEN,
  INVITE_TOKEN_MAX_LEN,
  type InviteId,
} from "../invites.js";

// Real RFC 9562 UUIDs (one v4, one v7) — z.uuid() validates the version
// nibble + variant bits in the canonical positions.
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const INVITER_PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";
const INVITE_ID = "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f00";
const EXPIRES_AT = "2026-06-15T12:30:00.000Z";

// Fixture returns a wire-shaped object without per-field brand casts —
// safeParse accepts plain UUID strings and brands them on the way out.
// The schema (not the type system) is the unit under test, so feeding raw
// wire data is the natural test surface.
const buildValidInviteCreate = () => ({
  sessionId: SESSION_ID,
  inviter: INVITER_PARTICIPANT_ID,
  joinMode: "collaborator" as const,
  expiresAt: EXPIRES_AT,
});

const buildValidInviteRevoke = () => ({
  sessionId: SESSION_ID,
  inviteId: INVITE_ID,
});

// =============================================================================
// InviteIdSchema — branded UUID guard (parallels SessionIdSchema)
// =============================================================================

describe("InviteIdSchema (branded UUID guard)", () => {
  it("accepts a valid RFC 9562 UUID", () => {
    const parsed = InviteIdSchema.parse(INVITE_ID);
    expect(parsed).toBe(INVITE_ID);
  });

  it("returns a branded InviteId at the type level", () => {
    // Compile-time proof that the brand survives `.parse()`. If parse()
    // ever degrades to `string`, this assignment fails to typecheck.
    const parsed: InviteId = InviteIdSchema.parse(INVITE_ID);
    expect(typeof parsed).toBe("string");
  });

  it.each([
    ["empty string", ""],
    ["plain word", "not-a-uuid"],
    ["wrong segment lengths", "0190f8a0-7e2d-7c4a-9b1c-1b7c5b3e8f0"],
    ["trailing suffix", `${INVITE_ID}-extra`],
  ])("rejects malformed UUID string: %s", (_label, value) => {
    expect(InviteIdSchema.safeParse(value).success).toBe(false);
  });
});

// =============================================================================
// C2 — InviteStateSchema lifecycle enum (Spec-002 line 43)
// =============================================================================
//
// Spec-002 line 43 binds the V1 invite lifecycle to EXACTLY four states.
// Two halves of the invariant:
//   1. Positive: the enum's option set equals {pending, accepted, revoked,
//      expired} (exact set, length 4 — neither a subset nor a superset).
//   2. Negative: "declined" is REJECTED. V1 declining is implicit (the
//      invitee does not click the shareable link); explicit `declined`
//      is a contract break.
//
// `InviteStateSchema` is typed as `z.ZodType<InviteState>` (a base ZodType
// abstraction); the underlying construct is `z.enum([...])` which exposes
// `.options`. We narrow with a runtime check before reading `.options` to
// keep the test resilient to refactors that swap the schema shape (e.g. a
// future `z.union([...])` would still need to enumerate the same set).

describe("InviteStateSchema (C2: lifecycle enum is exactly {pending, accepted, revoked, expired})", () => {
  const EXPECTED_STATES = ["pending", "accepted", "revoked", "expired"] as const;

  it("enumerates exactly four states (no more, no less)", () => {
    // Read `.options` from the underlying enum construct. The schema is
    // typed as the abstract `z.ZodType<InviteState>` so we cast via
    // `unknown` to read the construct-specific `.options` property; the
    // assertions below check both length AND exact set membership.
    const schemaInternals = InviteStateSchema as unknown as { options: readonly string[] };
    expect(schemaInternals.options).toHaveLength(4);
    expect([...schemaInternals.options].sort()).toEqual([...EXPECTED_STATES].sort());
  });

  it.each(EXPECTED_STATES)("accepts canonical V1 state: %s", (state) => {
    expect(InviteStateSchema.safeParse(state).success).toBe(true);
  });

  it("rejects 'declined' — V1 declining is implicit, not an explicit state (Spec-002 line 43)", () => {
    expect(InviteStateSchema.safeParse("declined").success).toBe(false);
  });

  it.each([
    ["unknown state", "approved"],
    ["empty string", ""],
    ["null", null],
    ["number", 1],
  ])("rejects non-canonical value: %s", (_label, value) => {
    expect(InviteStateSchema.safeParse(value).success).toBe(false);
  });
});

// =============================================================================
// C1 — InviteCreateSchema required fields (Spec-002 line 80)
// =============================================================================
//
// Spec-002 line 80: "`InviteCreate` must include session id, inviter,
// proposed join mode, and expiry." Omission of any of the four fields
// MUST reject with a clear path in the issue.

describe("InviteCreateSchema (C1: required fields per Spec-002 line 80)", () => {
  it("accepts a well-formed payload (all four required fields present)", () => {
    const parsed = InviteCreateSchema.parse(buildValidInviteCreate());
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.inviter).toBe(INVITER_PARTICIPANT_ID);
    expect(parsed.joinMode).toBe("collaborator");
    expect(parsed.expiresAt).toBe(EXPIRES_AT);
  });

  it.each(["sessionId", "inviter", "joinMode", "expiresAt"] as const)(
    "rejects a payload missing required field: %s (with the field name surfaced in the issue path)",
    (field) => {
      const valid = buildValidInviteCreate();
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      const result = InviteCreateSchema.safeParse(broken);
      expect(result.success).toBe(false);
      if (!result.success) {
        // Defense-in-depth: assert the issue path actually identifies the
        // missing field so error messages remain actionable for callers.
        const paths = result.error.issues.map((issue) => issue.path.join("."));
        expect(paths).toContain(field);
      }
    },
  );

  it.each(["viewer", "collaborator", "runtime contributor"] as const)(
    "accepts canonical join mode: %s",
    (joinMode) => {
      const payload = { ...buildValidInviteCreate(), joinMode };
      expect(InviteCreateSchema.safeParse(payload).success).toBe(true);
    },
  );

  it("rejects unknown join mode (e.g. 'owner' is a MembershipRole, not a JoinMode)", () => {
    const broken = { ...buildValidInviteCreate(), joinMode: "owner" };
    expect(InviteCreateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects malformed sessionId (UUID guard composes from SessionIdSchema)", () => {
    const broken = { ...buildValidInviteCreate(), sessionId: "not-a-uuid" };
    expect(InviteCreateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects malformed expiresAt (non-ISO datetime)", () => {
    const broken = { ...buildValidInviteCreate(), expiresAt: "tomorrow" };
    expect(InviteCreateSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts an ISO datetime with a numeric offset (RFC 3339 §5.6)", () => {
    const withOffset = { ...buildValidInviteCreate(), expiresAt: "2026-06-15T08:30:00-04:00" };
    expect(InviteCreateSchema.safeParse(withOffset).success).toBe(true);
  });

  it("rejects extraneous keys (.strict() guard matches session.ts convention)", () => {
    const broken = { ...buildValidInviteCreate(), unexpected: "field" };
    expect(InviteCreateSchema.safeParse(broken).success).toBe(false);
  });
});

// =============================================================================
// InviteAcceptSchema — opaque PASETO token (Spec-002 lines 107-113)
// =============================================================================

describe("InviteAcceptSchema (opaque PASETO token, Spec-002 lines 107-113)", () => {
  it("accepts a non-empty token string", () => {
    const result = InviteAcceptSchema.safeParse({ token: "v4.local.opaque-token-payload" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty token", () => {
    expect(InviteAcceptSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("rejects a missing token field", () => {
    expect(InviteAcceptSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an oversized token (defense-in-depth length cap)", () => {
    const broken = { token: "x".repeat(INVITE_TOKEN_MAX_LEN + 1) };
    expect(InviteAcceptSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a token at exactly the length cap (boundary)", () => {
    const ok = { token: "x".repeat(INVITE_TOKEN_MAX_LEN) };
    expect(InviteAcceptSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects extraneous keys (.strict() guard)", () => {
    const broken = { token: "v4.local.x", extra: 1 };
    expect(InviteAcceptSchema.safeParse(broken).success).toBe(false);
  });
});

// =============================================================================
// InviteRevokeSchema — exact wire shape (Spec-002 line 82)
// =============================================================================
//
// Spec-002 line 82 binds the wire shape verbatim:
//   `{sessionId: SessionId, inviteId: InviteId, reason?: string}`

describe("InviteRevokeSchema (exact shape per Spec-002 line 82)", () => {
  it("accepts the minimal valid request (sessionId + inviteId, no reason)", () => {
    const parsed = InviteRevokeSchema.parse(buildValidInviteRevoke());
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.inviteId).toBe(INVITE_ID);
    expect(parsed.reason).toBeUndefined();
  });

  it("accepts the request with an optional reason", () => {
    const payload = { ...buildValidInviteRevoke(), reason: "contractor offboarded 2026-05-21" };
    const parsed = InviteRevokeSchema.parse(payload);
    expect(parsed.reason).toBe("contractor offboarded 2026-05-21");
  });

  it.each(["sessionId", "inviteId"] as const)(
    "rejects request missing required field: %s",
    (field) => {
      const valid = buildValidInviteRevoke();
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      expect(InviteRevokeSchema.safeParse(broken).success).toBe(false);
    },
  );

  it("rejects malformed sessionId (UUID guard composes from SessionIdSchema)", () => {
    const broken = { ...buildValidInviteRevoke(), sessionId: "not-a-uuid" };
    expect(InviteRevokeSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects malformed inviteId (UUID guard from InviteIdSchema)", () => {
    const broken = { ...buildValidInviteRevoke(), inviteId: "not-a-uuid" };
    expect(InviteRevokeSchema.safeParse(broken).success).toBe(false);
  });

  it.each([
    ["empty reason", ""],
    ["whitespace-only reason", "   "],
    ["mixed whitespace reason", " \t\n "],
  ])("rejects %s (wireFreeFormString guard)", (_label, value) => {
    const broken = { ...buildValidInviteRevoke(), reason: value };
    expect(InviteRevokeSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a NUL-byte in reason (wireFreeFormString guard)", () => {
    const broken = { ...buildValidInviteRevoke(), reason: "revoked injected" };
    expect(InviteRevokeSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized reason (defense-in-depth length cap)", () => {
    const broken = {
      ...buildValidInviteRevoke(),
      reason: "x".repeat(INVITE_REVOKE_REASON_MAX_LEN + 1),
    };
    expect(InviteRevokeSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a reason at exactly the length cap (boundary)", () => {
    const ok = {
      ...buildValidInviteRevoke(),
      reason: "x".repeat(INVITE_REVOKE_REASON_MAX_LEN),
    };
    expect(InviteRevokeSchema.safeParse(ok).success).toBe(true);
  });

  it("rejects extraneous keys (.strict() matches session.ts request-schema convention)", () => {
    const broken = { ...buildValidInviteRevoke(), unexpected: "field" };
    expect(InviteRevokeSchema.safeParse(broken).success).toBe(false);
  });
});
