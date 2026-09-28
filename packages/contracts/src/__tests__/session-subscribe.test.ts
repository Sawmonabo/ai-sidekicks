// Direct schema coverage for the SessionSubscribe payload family.
//
// Coverage shape:
//   • Request:
//       - `{sessionId}` alone parses (the replay cursor is optional)
//       - `afterCursor` (IPC body convention) parses
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
  it("accepts a minimal request — the replay cursor is optional", () => {
    const parsed = SessionSubscribeRequestSchema.parse({ sessionId: SESSION_ID });
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.afterCursor).toBeUndefined();
  });

  it("accepts an `afterCursor` (IPC/JSON-RPC body convention)", () => {
    const parsed = SessionSubscribeRequestSchema.parse({
      sessionId: SESSION_ID,
      afterCursor: "42_1723291500000000000",
    });
    expect(parsed.afterCursor).toBe("42_1723291500000000000");
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

  it("rejects an empty-string afterCursor (opaque but non-empty)", () => {
    const result = SessionSubscribeRequestSchema.safeParse({
      sessionId: SESSION_ID,
      afterCursor: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an oversized afterCursor (defense-in-depth length cap)", () => {
    const result = SessionSubscribeRequestSchema.safeParse({
      sessionId: SESSION_ID,
      afterCursor: "x".repeat(EVENT_CURSOR_MAX_LEN + 1),
    });
    expect(result.success).toBe(false);
  });

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
