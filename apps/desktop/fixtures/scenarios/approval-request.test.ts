// The approval-request scenario, held to the properties a scenario file can silently lose.
//
// A scripted reply names a call something can actually make, and the scenario states
// which user this window is, from inside its own roster. The check's negative control is
// in `waiting-for-input.test.ts`.

import { describe, expect, it } from "vitest";

import { APPROVALS_SCENARIO } from "./approval-request.js";
import { unregisteredScriptedCalls } from "./scripted-calls.test-support.js";

describe("every scripted reply names a call something can make", () => {
  it("scripts no unregistered method", () => {
    expect(unregisteredScriptedCalls(APPROVALS_SCENARIO)).toStrictEqual([]);
  });
});

describe("the scenario states which user this window is", () => {
  it("names a caller inside its own roster", () => {
    expect(APPROVALS_SCENARIO.callerUserId).toBeDefined();
    expect(APPROVALS_SCENARIO.userIdsInJoinOrder).toContain(APPROVALS_SCENARIO.callerUserId);
  });
});
