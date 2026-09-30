// The waiting-for-input scenario keeps its replies to callable methods, so nothing answers
// `session.list`, and its caller inside its roster.

import { describe, expect, it } from "vitest";

import type { Scenario } from "../scenario.js";
import { unregisteredScriptedCalls } from "./scripted-calls.test-support.js";
import { WAITING_FOR_INPUT_SCENARIO } from "./waiting-for-input.js";

describe("every scripted reply names a call something can make", () => {
  it("scripts no unregistered method", () => {
    expect(unregisteredScriptedCalls(WAITING_FOR_INPUT_SCENARIO)).toStrictEqual([]);
  });

  it("negative control: the check reports a scenario that scripts one", () => {
    const control: Scenario = {
      ...WAITING_FOR_INPUT_SCENARIO,
      id: "composer-control",
      replies: [{ call: "session.list", result: { sessions: [] } }],
    };

    expect(unregisteredScriptedCalls(control)).toStrictEqual(["session.list"]);
  });
});

describe("the scenario states which user this window is", () => {
  it("names a caller inside its own roster", () => {
    expect(WAITING_FOR_INPUT_SCENARIO.callerUserId).toBeDefined();
    expect(WAITING_FOR_INPUT_SCENARIO.userIdsInJoinOrder).toContain(
      WAITING_FOR_INPUT_SCENARIO.callerUserId,
    );
  });
});
