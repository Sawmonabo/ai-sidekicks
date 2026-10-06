// The `session.notice` payload: each notice kind carries exactly its own members.
import { describe, expect, it } from "vitest";

import { SessionNoticePayloadSchema } from "../events.js";

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("SessionNoticePayloadSchema", () => {
  const updated = {
    sessionId: SESSION_ID,
    kind: "provider_updated",
    provider: "codex",
    fromVersion: "0.130.0",
    toVersion: "0.131.0",
  };

  it("takes each notice kind with exactly the members it carries", () => {
    const fastOutput = { sessionId: SESSION_ID, kind: "fast_output_unavailable" };
    const missing = {
      sessionId: SESSION_ID,
      kind: "provider_missing",
      provider: "claude",
      placeHasNeitherProvider: false,
    };
    const levelLeft = { sessionId: SESSION_ID, kind: "level_unavailable", level: "reviewed" };
    for (const notice of [updated, fastOutput, missing, levelLeft]) {
      expect(SessionNoticePayloadSchema.safeParse(notice).success).toBe(true);
    }
    expect(
      SessionNoticePayloadSchema.safeParse({ ...fastOutput, reason: "Not on this plan." }).success,
    ).toBe(true);
    // A build change names both builds; a missing provider says whether the place has neither;
    // the level left is a level the app has.
    const { toVersion: _toVersion, ...oneBuild } = updated;
    const { placeHasNeitherProvider: _place, ...unplaced } = missing;
    for (const notice of [oneBuild, unplaced, { ...levelLeft, level: "auto" }]) {
      expect(SessionNoticePayloadSchema.safeParse(notice).success).toBe(false);
    }
  });
});
