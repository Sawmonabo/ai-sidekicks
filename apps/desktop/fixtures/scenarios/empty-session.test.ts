// The empty-session scenario: the one state a script cannot reach.

import { describe, expect, it } from "vitest";

import { EMPTY_SESSION_SCENARIO } from "./empty-session.js";

describe("the empty-session scenario", () => {
  it("plays no beats at all, which is the one state a script cannot reach", () => {
    expect(EMPTY_SESSION_SCENARIO.beats).toStrictEqual([]);
  });

  it("names a caller who is actually in the roster", () => {
    expect(EMPTY_SESSION_SCENARIO.userIdsInJoinOrder).toContain(
      EMPTY_SESSION_SCENARIO.callerUserId,
    );
  });

  it("scripts no reply for a call the method registry does not carry", () => {
    const calls = EMPTY_SESSION_SCENARIO.replies.map((reply) => reply.call);
    expect(calls).not.toContain("session.list");
    expect(calls).toContain("session.read");
  });
});
