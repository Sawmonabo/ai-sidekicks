// The empty-session scenario: the one state a script cannot reach.

import { describe, expect, it } from "vitest";

import { LEDGER_QUIET_SCENARIO } from "./empty-session.js";

describe("the empty-session scenario", () => {
  it("plays no beats at all, which is the one state a script cannot reach", () => {
    expect(LEDGER_QUIET_SCENARIO.beats).toStrictEqual([]);
  });

  it("names a caller who is actually in the roster", () => {
    expect(LEDGER_QUIET_SCENARIO.userIdsInJoinOrder).toContain(LEDGER_QUIET_SCENARIO.callerUserId);
  });

  it("scripts no reply for a call the method registry does not carry", () => {
    const calls = LEDGER_QUIET_SCENARIO.replies.map((reply) => reply.call);
    expect(calls).not.toContain("session.list");
    expect(calls).toContain("session.read");
  });
});
