// The `session.subscribe` frame: a batch of changes with no frame cursor, or the caught-up frame
// (no changes, the drop mark, the newest cursor). Any other combination would leave the client
// without a position to resume from.
import { describe, expect, it } from "vitest";

import { SessionEventSchema } from "../event.js";
import { SessionStreamFrameSchema } from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

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

  it("accepts a batch carrying the drop mark", () => {
    expect(FrameSchema.safeParse({ changes: [change("c-9")], dropped: true }).success).toBe(true);
  });

  it("accepts the caught-up frame: no changes, the drop mark and the newest cursor", () => {
    expect(FrameSchema.safeParse({ changes: [], dropped: true, cursor: "c-9" }).success).toBe(true);
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
});
