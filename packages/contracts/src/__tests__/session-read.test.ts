// The `session.read` request and answer: what the daemon may send, and what it must never.
// Both shapes are strict at every nesting level. A session id is required and UUID-guarded, the
// answer carries the held draft, `timelineCursors.acknowledged` is optional, snapshot datetimes
// accept numeric offsets and `Z`, and a cursor is non-empty and capped at
// `EVENT_CURSOR_MAX_LEN` as defense in depth.
import { describe, expect, it } from "vitest";

import {
  EVENT_CURSOR_MAX_LEN,
  SessionReadRequestSchema,
  SessionReadResponseSchema,
} from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

// The fixture is wire-shaped with no brand casts: `safeParse` accepts plain UUID strings and
// brands them on the way out, so the schema, not the type system, is what is under test.
const buildValidResponse = () => ({
  session: {
    id: SESSION_ID,
    state: "active" as const,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:05:00.000Z",
    draft: "Half a thought about the retry loop",
  },
  timelineCursors: {
    latest: "42_1723291500000000000",
  },
});

describe("SessionReadRequestSchema (request shape)", () => {
  it("accepts a well-formed request and round-trips the sessionId", () => {
    const parsed = SessionReadRequestSchema.parse({ sessionId: SESSION_ID });
    expect(parsed.sessionId).toBe(SESSION_ID);
  });

  it("rejects a request missing `sessionId`", () => {
    const result = SessionReadRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a malformed sessionId (UUID guard reuses C1 invariant)", () => {
    const result = SessionReadRequestSchema.safeParse({ sessionId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object body (string)", () => {
    const result = SessionReadRequestSchema.safeParse("not-an-object");
    expect(result.success).toBe(false);
  });

  it("rejects a null body", () => {
    const result = SessionReadRequestSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (.strict() guard)", () => {
    const result = SessionReadRequestSchema.safeParse({
      sessionId: SESSION_ID,
      unexpected: "field",
    });
    expect(result.success).toBe(false);
  });
});

describe("SessionReadResponseSchema (response shape)", () => {
  it("accepts a well-formed response and round-trips snapshot + cursor values", () => {
    const parsed = SessionReadResponseSchema.parse(buildValidResponse());
    expect(parsed.session.id).toBe(SESSION_ID);
    expect(parsed.session.state).toBe("active");
    expect(parsed.timelineCursors.latest).toBe("42_1723291500000000000");
    expect(parsed.timelineCursors.acknowledged).toBeUndefined();
  });

  it("accepts an `acknowledged` cursor when present (optional field, present arm)", () => {
    const valid = buildValidResponse();
    const withAck = {
      ...valid,
      timelineCursors: { ...valid.timelineCursors, acknowledged: "41_1723291400000000000" },
    };
    const parsed = SessionReadResponseSchema.parse(withAck);
    expect(parsed.timelineCursors.acknowledged).toBe("41_1723291400000000000");
  });

  it.each(["session", "timelineCursors"] as const)(
    "rejects a response missing required field: %s",
    (field) => {
      const broken = { ...buildValidResponse() } as Record<string, unknown>;
      delete broken[field];
      const result = SessionReadResponseSchema.safeParse(broken);
      expect(result.success).toBe(false);
    },
  );

  it("rejects a response missing `timelineCursors.latest`", () => {
    const broken = { ...buildValidResponse(), timelineCursors: {} };
    const result = SessionReadResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields at the top level (.strict() guard)", () => {
    const broken = { ...buildValidResponse(), unexpected: "field" };
    const result = SessionReadResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields inside `timelineCursors` (nested .strict())", () => {
    const valid = buildValidResponse();
    const broken = {
      ...valid,
      timelineCursors: { ...valid.timelineCursors, unexpected: "field" },
    };
    const result = SessionReadResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("carries the held draft, and refuses a snapshot without one", () => {
    expect(SessionReadResponseSchema.parse(buildValidResponse()).session.draft).toBe(
      "Half a thought about the retry loop",
    );
    const valid = buildValidResponse();
    const { draft: _draft, ...withoutDraft } = valid.session;
    expect(SessionReadResponseSchema.safeParse({ ...valid, session: withoutDraft }).success).toBe(
      false,
    );
  });

  it("rejects unknown extra fields inside `session` (SessionSnapshot .strict())", () => {
    const valid = buildValidResponse();
    const broken = { ...valid, session: { ...valid.session, unexpected: "field" } };
    const result = SessionReadResponseSchema.safeParse(broken);
    expect(result.success).toBe(false);
  });

  it("accepts snapshot datetimes with RFC 3339 numeric offsets (wire contract widens past Z)", () => {
    const valid = buildValidResponse();
    const offsetForm = {
      ...valid,
      session: {
        ...valid.session,
        createdAt: "2026-08-10T07:00:00.000-05:00",
        updatedAt: "2026-08-10T12:05:00.000+00:00",
      },
    };
    expect(SessionReadResponseSchema.safeParse(offsetForm).success).toBe(true);
  });

  it("rejects a non-ISO snapshot datetime", () => {
    const valid = buildValidResponse();
    const broken = {
      ...valid,
      session: { ...valid.session, createdAt: "August 10, 2026" },
    };
    expect(SessionReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an unknown session `state` enum value", () => {
    const valid = buildValidResponse();
    const broken = { ...valid, session: { ...valid.session, state: "totally-made-up" } };
    expect(SessionReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an empty-string `latest` cursor (opaque but non-empty)", () => {
    const valid = buildValidResponse();
    const broken = { ...valid, timelineCursors: { latest: "" } };
    expect(SessionReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects an oversized cursor (defense-in-depth length cap)", () => {
    const valid = buildValidResponse();
    const broken = {
      ...valid,
      timelineCursors: { latest: "x".repeat(EVENT_CURSOR_MAX_LEN + 1) },
    };
    expect(SessionReadResponseSchema.safeParse(broken).success).toBe(false);
  });

  it("accepts a cursor at exactly the length cap (boundary)", () => {
    const valid = buildValidResponse();
    const ok = {
      ...valid,
      timelineCursors: { latest: "x".repeat(EVENT_CURSOR_MAX_LEN) },
    };
    expect(SessionReadResponseSchema.safeParse(ok).success).toBe(true);
  });
});
