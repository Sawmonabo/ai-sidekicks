// `SessionCreate` payload validates required fields.
//
// Backstops session creation with a stable id and an initial projection.
// The request schema is permissive (both fields optional —
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
//       - missing `sessionId` / `state` rejects
//       - invalid `state` enum value rejects
import { describe, expect, it } from "vitest";

import { SessionCreateRequestSchema, SessionCreateResponseSchema } from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

// Fixture returns a wire-shaped object with no per-field brand casts —
// `safeParse` accepts plain UUID strings and brands them on the way out.
// The schema (not the type system) is the unit under test, so feeding raw
// wire data is the natural test surface; the inferred return shape is the
// plain object literal which is structurally compatible with each test's
// spread/delete operations.
const buildValidResponse = () => ({
  sessionId: SESSION_ID,
  state: "active" as const,
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

describe("SessionCreateResponseSchema (response shape)", () => {
  it("accepts a well-formed response and round-trips field values", () => {
    const valid = buildValidResponse();
    const parsed = SessionCreateResponseSchema.parse(valid);
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.state).toBe("active");
  });

  it.each(["sessionId", "state"] as const)(
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

  it("rejects a malformed sessionId (UUID guard composes)", () => {
    const broken = { ...buildValidResponse(), sessionId: "not-a-uuid" };
    const result = SessionCreateResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });
});
