// What a command line asking for a fixture launch is allowed to say.
//
// A launch the catalog cannot play is a startup error with no fallback, so each malformed
// spelling below has to be refused rather than read leniently into some other launch, and
// each refusal sits beside a well-formed launch that passes.

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "../../fixtures/scenarios/first-run.js";
import { FLAGSHIP_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";
import { checkFixtureLaunchAgainstCatalog, parseFixtureLaunch } from "./fixture-launch.js";

/** What Electron and a test driver put on a command line besides the app's own arguments. */
const SHELL_ARGUMENTS = ["--user-data-dir=/tmp/profile", "--inspect=0", "out/main/index.js"];

describe("parseFixtureLaunch", () => {
  it("reads a normal launch as no fixture launch", () => {
    expect(parseFixtureLaunch(SHELL_ARGUMENTS)).toBeUndefined();
  });

  it.each([
    [["--fixture", "first-run"], { scenarioId: "first-run" }],
    [["--fixture=first-run"], { scenarioId: "first-run" }],
    [
      ["--fixture", "first-run", "--session", "session-a"],
      { scenarioId: "first-run", sessionId: "session-a" },
    ],
  ])("reads %j among the shell's arguments", (launchArguments, launch) => {
    expect(parseFixtureLaunch([...SHELL_ARGUMENTS, ...launchArguments])).toEqual(launch);
  });

  it.each([
    [["--fixture"], "--fixture needs a value"],
    [["--fixture", "--session", "session-a"], "--fixture needs a value"],
    [["--fixture", "first-run", "--session"], "--session needs a value"],
    [
      ["--fixture", "first-run", "--fixture", "empty-session"],
      "--fixture was given more than once",
    ],
    [["--session", "session-a"], "--session opens a session in a fixture scenario"],
  ])("refuses %j", (launchArguments, refusal) => {
    expect(() => parseFixtureLaunch([...SHELL_ARGUMENTS, ...launchArguments])).toThrow(refusal);
  });
});

describe("checkFixtureLaunchAgainstCatalog", () => {
  it("accepts a scenario the catalog holds, alone or with its own session", async () => {
    await expect(
      checkFixtureLaunchAgainstCatalog({ scenarioId: FIRST_RUN_SCENARIO.id }),
    ).resolves.toBeUndefined();
    await expect(
      checkFixtureLaunchAgainstCatalog({
        scenarioId: FLAGSHIP_SCENARIO.id,
        sessionId: FLAGSHIP_SCENARIO.sessionId,
      }),
    ).resolves.toBeUndefined();
  });

  it("refuses a scenario the catalog does not hold, naming the ones it does", async () => {
    await expect(
      checkFixtureLaunchAgainstCatalog({ scenarioId: "no-such-scenario" }),
    ).rejects.toThrow(FIRST_RUN_SCENARIO.id);
  });

  it("refuses a session the scenario does not hold", async () => {
    await expect(
      checkFixtureLaunchAgainstCatalog({
        scenarioId: FIRST_RUN_SCENARIO.id,
        sessionId: FLAGSHIP_SCENARIO.sessionId,
      }),
    ).rejects.toThrow(`not "${FLAGSHIP_SCENARIO.sessionId}"`);
  });
});
