// The `session.read` answer always carries the session's held draft and the position a reader
// resumes from when it has acknowledged nothing.
import { describe, expect, it } from "vitest";

import { encodeEventCursor, START_OF_LOG_POSITION } from "../id.js";
import { SessionReadResponseSchema } from "../methods.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

// Wire-shaped with no brand casts: `safeParse` accepts plain UUID strings and brands them on the
// way out, so the schema, not the type system, is what is under test.
const buildValidResponse = () => ({
  session: {
    id: SESSION_ID,
    state: "active" as const,
    shape: "chat" as const,
    muted: false,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:05:00.000Z",
    draft: "Half a thought about the retry loop",
    tags: ["billing/refunds"],
  },
  transcriptCursors: {
    earliest: encodeEventCursor(START_OF_LOG_POSITION),
    latest: encodeEventCursor(42),
  },
});

describe("SessionReadResponseSchema", () => {
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

  it("refuses a cursor block with no earliest position", () => {
    const valid = buildValidResponse();
    expect(SessionReadResponseSchema.safeParse(valid).success).toBe(true);
    const { earliest: _earliest, ...withoutEarliest } = valid.transcriptCursors;
    expect(
      SessionReadResponseSchema.safeParse({ ...valid, transcriptCursors: withoutEarliest }).success,
    ).toBe(false);
  });
});
