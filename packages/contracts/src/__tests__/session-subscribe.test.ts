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
//   • Frame (each notify's value):
//       - a batch of changes, each with its cursor, parses, with or without the drop mark
//       - the caught-up frame (no changes, the drop mark, the newest cursor) parses
//       - refused: too many changes, an empty frame that is not the caught-up frame, a frame
//         cursor beside changes, a change without a cursor, an unknown member
import { describe, expect, it } from "vitest";

import { SessionEventSchema } from "../event.js";
import { STREAM_FRAME_MAX_CHANGES } from "../jsonrpc-streaming.js";
import {
  EVENT_CURSOR_MAX_LEN,
  SessionStreamFrameSchema,
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

describe("SessionStreamFrameSchema (each `session.subscribe` notify's value)", () => {
  const FrameSchema = SessionStreamFrameSchema(SessionEventSchema);
  const event = {
    id: "evt-0001",
    sessionId: SESSION_ID,
    sequence: 0,
    occurredAt: "2026-01-22T19:14:35.000Z",
    category: "session_lifecycle",
    type: "session.created",
    actor: null,
    version: "1.0",
    payload: {
      sessionId: SESSION_ID,
      shape: "chat",
      mainAgent: {
        agentId: "44444444-4444-4444-8444-444444444444",
        name: "Implementer",
        binding: {
          driverName: "claude",
          modelId: "claude-sonnet-5",
          providerAccountId: null,
          effort: null,
        },
        ancestry: [],
        createdAt: "2026-01-22T19:14:35.000Z",
      },
    },
  };
  const change = (cursor: string): { cursor: string; event: typeof event } => ({ cursor, event });

  it("accepts a batch of changes, each with its cursor", () => {
    expect(FrameSchema.safeParse({ changes: [change("c-1"), change("c-2")] }).success).toBe(true);
  });

  it("accepts a batch carrying the drop mark", () => {
    expect(FrameSchema.safeParse({ changes: [change("c-9")], dropped: true }).success).toBe(true);
  });

  it("accepts the caught-up frame: no changes, the drop mark and the newest cursor", () => {
    expect(FrameSchema.safeParse({ changes: [], dropped: true, cursor: "c-9" }).success).toBe(true);
  });

  it(`refuses more than ${String(STREAM_FRAME_MAX_CHANGES)} changes in one frame`, () => {
    const changes = Array.from({ length: STREAM_FRAME_MAX_CHANGES + 1 }, (_, index) =>
      change(`c-${String(index)}`),
    );
    expect(FrameSchema.safeParse({ changes }).success).toBe(false);
  });

  it("refuses an empty frame without the drop mark and the newest cursor", () => {
    expect(FrameSchema.safeParse({ changes: [] }).success).toBe(false);
    expect(FrameSchema.safeParse({ changes: [], dropped: true }).success).toBe(false);
    expect(FrameSchema.safeParse({ changes: [], cursor: "c-9" }).success).toBe(false);
  });

  it("refuses a frame cursor beside changes", () => {
    expect(
      FrameSchema.safeParse({ changes: [change("c-1")], dropped: true, cursor: "c-1" }).success,
    ).toBe(false);
  });

  it("refuses a change without its cursor", () => {
    expect(FrameSchema.safeParse({ changes: [{ event }] }).success).toBe(false);
  });

  it("refuses an unknown member on the frame or on a change", () => {
    expect(FrameSchema.safeParse({ changes: [change("c-1")], gap: true }).success).toBe(false);
    expect(FrameSchema.safeParse({ changes: [{ ...change("c-1"), sequence: 1 }] }).success).toBe(
      false,
    );
  });
});
