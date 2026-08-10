// Plan-001 file-row errata PR (2026-08-10) — direct schema coverage for the
// SessionRead payload family. T2.1's Files row promised a `session.test.ts`
// covering all five payload schema families; the shipped split
// (session-id / session-create / session-join) left SessionRead exercised
// only transitively through consumer suites
// (`packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts#SessionReadResponseSchema`,
// control-plane router). This file completes the SessionRead leg of the
// direct coverage — see the `Plan-001 §Decision Log` errata entry, same date.
//
// Backstops Spec-001 AC3 (session id stable across reconnect — read resolves
// the projection by id) and AC6 (reconnecting clients restore from the
// authoritative snapshot plus replay cursors, never client cache).
//
// Coverage shape:
//   • Request:
//       - `{sessionId}` parses; sessionId is required and UUID-guarded
//       - non-object / null input is rejected
//       - extra unknown keys are rejected (`.strict()` enforcement)
//   • Response:
//       - well-formed payload parses, preserves snapshot + cursor values
//       - `timelineCursors.acknowledged` is optional (absent AND present ok)
//       - missing `session` / `timelineCursors` rejects
//       - `.strict()` holds at every nesting level (top, cursors, snapshot)
//       - snapshot datetimes accept RFC 3339 numeric offsets AND Z-suffix
//       - cursor bounds: empty rejects (min 1), oversized rejects
//         (EVENT_CURSOR_MAX_LEN defense-in-depth cap), boundary accepts
import { describe, expect, it } from "vitest";

import {
  EVENT_CURSOR_MAX_LEN,
  SessionReadRequestSchema,
  SessionReadResponseSchema,
} from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

// Fixture returns a wire-shaped object with no per-field brand casts —
// `safeParse` accepts plain UUID strings and brands them on the way out
// (same rationale as session-create.test.ts's buildValidResponse).
const buildValidResponse = () => ({
  session: {
    id: SESSION_ID,
    state: "active" as const,
    config: { resourceLimits: { sessions: 10 } },
    metadata: { source: "cli" },
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:05:00.000Z",
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
