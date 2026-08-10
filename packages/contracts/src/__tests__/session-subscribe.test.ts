// Plan-001 file-row errata PR (2026-08-10) — direct schema coverage for the
// SessionSubscribe payload family. T2.1's Files row promised a
// `session.test.ts` covering all five payload schema families; the shipped
// split covered three directly, with SessionSubscribe exercised only
// transitively through consumer suites
// (`packages/runtime-daemon/src/ipc/handlers/__tests__/session-handlers.test.ts`,
// control-plane SSE factory). This file completes the direct coverage — see
// the Plan-001 §Decision Log errata entry, same date.
//
// Backstops Spec-001 AC4 (a joining client receives full event history —
// subscribe replay is the delivery surface) and AC6 (replay-from-cursor:
// `afterCursor` for IPC clients, `lastEventId` for SSE reconnects).
//
// Coverage shape:
//   • Request:
//       - `{sessionId}` alone parses (both replay cursors optional)
//       - `afterCursor` (IPC body convention) parses
//       - `lastEventId` (tRPC v11 SSE `Last-Event-ID` header injection,
//         pre-Zod — the field .strict() would otherwise reject on every
//         reconnect) parses, alone and alongside `afterCursor`
//       - sessionId is required and UUID-guarded
//       - extra unknown keys are rejected (`.strict()` enforcement)
//       - cursor bounds: empty rejects (min 1), oversized rejects
//         (EVENT_CURSOR_MAX_LEN defense-in-depth cap), boundary accepts
//   • Response (alias seam over the canonical SubscribeAckResponse):
//       - `{subscriptionId}` parses; UUID-guarded; extra keys rejected
import { describe, expect, it } from "vitest";

import {
  EVENT_CURSOR_MAX_LEN,
  SessionSubscribeRequestSchema,
  SessionSubscribeResponseSchema,
} from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const SUBSCRIPTION_ID = "990e8400-e29b-41d4-a716-446655440004";

describe("SessionSubscribeRequestSchema (request shape)", () => {
  it("accepts a minimal request — both replay cursors are optional", () => {
    const parsed = SessionSubscribeRequestSchema.parse({ sessionId: SESSION_ID });
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.afterCursor).toBeUndefined();
    expect(parsed.lastEventId).toBeUndefined();
  });

  it("accepts an `afterCursor` (IPC/JSON-RPC body convention)", () => {
    const parsed = SessionSubscribeRequestSchema.parse({
      sessionId: SESSION_ID,
      afterCursor: "42_1723291500000000000",
    });
    expect(parsed.afterCursor).toBe("42_1723291500000000000");
  });

  it("accepts a `lastEventId` (SSE Last-Event-ID header, injected pre-validation)", () => {
    const parsed = SessionSubscribeRequestSchema.parse({
      sessionId: SESSION_ID,
      lastEventId: "43_1723291600000000000",
    });
    expect(parsed.lastEventId).toBe("43_1723291600000000000");
  });

  it("accepts both cursors together (reconnect with a stale cached afterCursor)", () => {
    const result = SessionSubscribeRequestSchema.safeParse({
      sessionId: SESSION_ID,
      afterCursor: "42_1723291500000000000",
      lastEventId: "43_1723291600000000000",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a request missing `sessionId`", () => {
    const result = SessionSubscribeRequestSchema.safeParse({
      afterCursor: "42_1723291500000000000",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed sessionId (UUID guard reuses C1 invariant)", () => {
    const result = SessionSubscribeRequestSchema.safeParse({ sessionId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (.strict() guard)", () => {
    const result = SessionSubscribeRequestSchema.safeParse({
      sessionId: SESSION_ID,
      unexpected: "field",
    });
    expect(result.success).toBe(false);
  });

  it.each(["afterCursor", "lastEventId"] as const)(
    "rejects an empty-string %s (opaque but non-empty)",
    (field) => {
      const result = SessionSubscribeRequestSchema.safeParse({
        sessionId: SESSION_ID,
        [field]: "",
      });
      expect(result.success).toBe(false);
    },
  );

  it.each(["afterCursor", "lastEventId"] as const)(
    "rejects an oversized %s (defense-in-depth length cap)",
    (field) => {
      const result = SessionSubscribeRequestSchema.safeParse({
        sessionId: SESSION_ID,
        [field]: "x".repeat(EVENT_CURSOR_MAX_LEN + 1),
      });
      expect(result.success).toBe(false);
    },
  );

  it("accepts a cursor at exactly the length cap (boundary)", () => {
    const result = SessionSubscribeRequestSchema.safeParse({
      sessionId: SESSION_ID,
      afterCursor: "x".repeat(EVENT_CURSOR_MAX_LEN),
    });
    expect(result.success).toBe(true);
  });
});

describe("SessionSubscribeResponseSchema (alias seam over SubscribeAckResponse)", () => {
  it("accepts a well-formed ack and round-trips the subscriptionId", () => {
    const parsed = SessionSubscribeResponseSchema.parse({ subscriptionId: SUBSCRIPTION_ID });
    expect(parsed.subscriptionId).toBe(SUBSCRIPTION_ID);
  });

  it("rejects an ack missing `subscriptionId`", () => {
    const result = SessionSubscribeResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects a malformed subscriptionId (UUID guard)", () => {
    const result = SessionSubscribeResponseSchema.safeParse({ subscriptionId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (.strict() guard — the ack stays minimal)", () => {
    const result = SessionSubscribeResponseSchema.safeParse({
      subscriptionId: SUBSCRIPTION_ID,
      unexpected: "field",
    });
    expect(result.success).toBe(false);
  });
});
