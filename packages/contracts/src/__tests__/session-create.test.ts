// Plan-001 PR #2 — Test C2: `SessionCreate payload validates required fields`.
//
// Backstops Spec-001 AC1 (a session is created with stable id + initial
// projection). The request schema is permissive (both fields optional —
// the daemon fills defaults from session config); the response schema is
// strict — every projection field must be present so downstream consumers
// can rebuild local state without an extra round trip.
//
// Coverage shape:
//   • Request:
//       - empty `{}` parses (defaults are server-side)
//       - partial `{config}` and `{metadata}` parse
//       - non-object input (string, null) is rejected
//       - extra unknown keys are rejected (`.strict()` enforcement)
//   • Response:
//       - well-formed payload parses, preserves field shapes
//       - missing `sessionId` / `state` / `memberships` / `channels` rejects
//       - invalid `state` enum value rejects
//       - inner `memberships[].state` enum violation rejects (composability)
import { describe, expect, it } from "vitest";

import {
  CHANNEL_NAME_MAX_LEN,
  SessionCreateRequestSchema,
  SessionCreateResponseSchema,
} from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const PARTICIPANT_ID = "660e8400-e29b-41d4-a716-446655440001";
const MEMBERSHIP_ID = "770e8400-e29b-41d4-a716-446655440002";
const CHANNEL_ID = "880e8400-e29b-41d4-a716-446655440003";

// Fixture returns a wire-shaped object with no per-field brand casts —
// `safeParse` accepts plain UUID strings and brands them on the way out.
// The schema (not the type system) is the unit under test, so feeding raw
// wire data is the natural test surface; the inferred return shape is the
// plain object literal which is structurally compatible with each test's
// spread/delete operations.
const buildValidResponse = () => ({
  sessionId: SESSION_ID,
  state: "active" as const,
  memberships: [
    {
      id: MEMBERSHIP_ID,
      participantId: PARTICIPANT_ID,
      role: "owner" as const,
      state: "active" as const,
    },
  ],
  channels: [
    {
      id: CHANNEL_ID,
      state: "active" as const,
    },
  ],
});

describe("SessionCreateRequestSchema (C2: request shape)", () => {
  it("accepts an empty body — both fields are optional", () => {
    const result = SessionCreateRequestSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a body with only `config`", () => {
    const result = SessionCreateRequestSchema.safeParse({ config: { foo: 1 } });
    expect(result.success).toBe(true);
  });

  it("accepts a body with only `metadata`", () => {
    const result = SessionCreateRequestSchema.safeParse({
      metadata: { tag: "v1" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a body with both `config` and `metadata`", () => {
    const result = SessionCreateRequestSchema.safeParse({
      config: { resourceLimits: { sessions: 10 } },
      metadata: { source: "cli" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-object body (string)", () => {
    const result = SessionCreateRequestSchema.safeParse("not-an-object");
    expect(result.success).toBe(false);
  });

  it("rejects a null body", () => {
    const result = SessionCreateRequestSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (.strict() guard)", () => {
    const result = SessionCreateRequestSchema.safeParse({
      config: {},
      unexpected: "field",
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionCreateResponseSchema (C2: response shape)", () => {
  it("accepts a well-formed response and round-trips field values", () => {
    const valid = buildValidResponse();
    const parsed = SessionCreateResponseSchema.parse(valid);
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.state).toBe("active");
    expect(parsed.memberships).toHaveLength(1);
    expect(parsed.memberships[0]?.role).toBe("owner");
    expect(parsed.channels[0]?.state).toBe("active");
  });

  it("accepts an empty memberships and channels list (Spec-001 §State 'provisioning')", () => {
    const provisioning = {
      ...buildValidResponse(),
      state: "provisioning",
      memberships: [],
      channels: [],
    };
    const result = SessionCreateResponseSchema.safeParse(provisioning);
    expect(result.success).toBe(true);
  });

  it.each(["sessionId", "state", "memberships", "channels"] as const)(
    "rejects a response missing required field: %s",
    (field) => {
      const valid = buildValidResponse();
      const broken = { ...valid } as Record<string, unknown>;
      delete broken[field];
      const result = SessionCreateResponseSchema.safeParse(broken);
      expect(result.success).toBe(false);
    },
  );

  it("rejects an unknown `state` enum value", () => {
    const broken = { ...buildValidResponse(), state: "totally-made-up" };
    const result = SessionCreateResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects nested membership with invalid `state` enum (composability)", () => {
    const valid = buildValidResponse();
    const broken = {
      ...valid,
      memberships: [{ ...valid.memberships[0]!, state: "totally-made-up" }],
    };
    const result = SessionCreateResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects a malformed sessionId (UUID guard reuses C1 invariant)", () => {
    const broken = { ...buildValidResponse(), sessionId: "not-a-uuid" };
    const result = SessionCreateResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  // --------------------------------------------------------------------
  // Round 3 R2-5: ChannelSummary.name length cap + whitespace + NUL guards
  // --------------------------------------------------------------------
  // The `name` field is optional on the wire (the implicit `main` channel
  // is unnamed); when present, the same `wireFreeFormString` guards that
  // protect `identityHandle` apply (channel names are user-visible UI
  // labels — same trust-boundary stance).

  it("accepts a channel with no `name` (the implicit main channel)", () => {
    const valid = buildValidResponse();
    expect(SessionCreateResponseSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts a channel with a normal `name`", () => {
    const valid = buildValidResponse();
    const withName = {
      ...valid,
      channels: [{ ...valid.channels[0]!, name: "general" }],
    };
    expect(SessionCreateResponseSchema.safeParse(withName).success).toBe(true);
  });

  it.each([
    ["empty string", ""],
    ["single space", " "],
    ["multiple spaces", "   "],
    ["mixed whitespace", " \t\n "],
  ])("rejects a whitespace-only channel name: %s", (_label, value) => {
    const valid = buildValidResponse();
    const broken = {
      ...valid,
      channels: [{ ...valid.channels[0]!, name: value }],
    };
    expect(SessionCreateResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a NUL-byte channel name", () => {
    const valid = buildValidResponse();
    const broken = {
      ...valid,
      channels: [{ ...valid.channels[0]!, name: "general\u0000extra" }],
    };
    expect(SessionCreateResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized channel name (defense-in-depth length cap)", () => {
    const valid = buildValidResponse();
    const broken = {
      ...valid,
      channels: [{ ...valid.channels[0]!, name: "x".repeat(CHANNEL_NAME_MAX_LEN + 1) }],
    };
    expect(SessionCreateResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a channel name at exactly the length cap (boundary)", () => {
    const valid = buildValidResponse();
    const ok = {
      ...valid,
      channels: [{ ...valid.channels[0]!, name: "x".repeat(CHANNEL_NAME_MAX_LEN) }],
    };
    expect(SessionCreateResponseSchema.safeParse(ok).success).toBe(true);
  });
});
