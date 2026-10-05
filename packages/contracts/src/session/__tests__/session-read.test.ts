// The `session.read` answer always carries the session's held draft.
import { describe, expect, it } from "vitest";

import { SessionReadResponseSchema } from "../session.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

// Wire-shaped with no brand casts: `safeParse` accepts plain UUID strings and brands them on the
// way out, so the schema, not the type system, is what is under test.
const buildValidResponse = () => ({
  session: {
    id: SESSION_ID,
    state: "active" as const,
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:05:00.000Z",
    draft: "Half a thought about the retry loop",
  },
  transcriptCursors: {
    latest: "42_1723291500000000000",
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
});
