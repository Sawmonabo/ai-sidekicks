// The approval-request scenario keeps its replies to callable methods and its caller inside
// its roster. The negative control for the reply check is in `waiting-for-input.test.ts`.

import { describe, expect, it } from "vitest";

import { APPROVAL_REQUEST_SCENARIO } from "./approval-request.js";
import { unregisteredScriptedCalls } from "./scripted-calls.test-support.js";

describe("every scripted reply names a call something can make", () => {
  it("scripts no unregistered method", () => {
    expect(unregisteredScriptedCalls(APPROVAL_REQUEST_SCENARIO)).toStrictEqual([]);
  });
});

describe("the scenario states which user this window is", () => {
  it("names a caller inside its own roster", () => {
    expect(APPROVAL_REQUEST_SCENARIO.callerUserId).toBeDefined();
    expect(APPROVAL_REQUEST_SCENARIO.userIdsInJoinOrder).toContain(
      APPROVAL_REQUEST_SCENARIO.callerUserId,
    );
  });
});
