// The waiting-for-input scenario, held to the properties a scenario file can silently lose.
//
// A scripted reply names a call something can actually make: the registry carries no
// `session.list`, so a reply for it is an answer to a question no surface asks. And the
// scenario states which user this window is, from inside its own roster.

import { describe, expect, it } from "vitest";

import type { ConsoleScenario } from "../scenario.js";
import { unregisteredScriptedCalls } from "./scripted-calls.test-support.js";
import { COMPOSER_SCENARIO } from "./waiting-for-input.js";

describe("every scripted reply names a call something can make", () => {
  it("scripts no unregistered method", () => {
    expect(unregisteredScriptedCalls(COMPOSER_SCENARIO)).toStrictEqual([]);
  });

  it("negative control: the check reports a scenario that scripts one", () => {
    const control: ConsoleScenario = {
      ...COMPOSER_SCENARIO,
      id: "composer-control",
      replies: [{ call: "session.list", result: { sessions: [] } }],
    };

    expect(unregisteredScriptedCalls(control)).toStrictEqual(["session.list"]);
  });
});

describe("the scenario states which user this window is", () => {
  it("names a caller inside its own roster", () => {
    expect(COMPOSER_SCENARIO.callerUserId).toBeDefined();
    expect(COMPOSER_SCENARIO.userIdsInJoinOrder).toContain(COMPOSER_SCENARIO.callerUserId);
  });
});
