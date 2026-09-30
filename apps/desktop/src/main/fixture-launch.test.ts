// A malformed fixture launch stops startup with an error that names what is wrong, rather than
// being read leniently into some other launch; each refusal sits beside a well-formed launch
// that passes.

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "../../fixtures/scenarios/first-run.js";
import { CONCURRENT_STREAMING_SCENARIO } from "../../fixtures/scenarios/concurrent-streaming.js";
import { checkFixtureLaunchAgainstCatalog, parseFixtureLaunch } from "./fixture-launch.js";

/** What Electron and a test driver put on a command line besides the app's own arguments. */
const ELECTRON_ARGUMENTS = ["--user-data-dir=/tmp/profile", "--inspect=0", "out/main/index.js"];

describe("parseFixtureLaunch", () => {
  it("reads a scenario and its session among the main process's arguments", () => {
    expect(
      parseFixtureLaunch([
        ...ELECTRON_ARGUMENTS,
        "--fixture",
        "first-run",
        "--session",
        "session-a",
      ]),
    ).toEqual({ scenarioId: "first-run", sessionId: "session-a" });
  });

  it.each([
    [["--fixture"], "--fixture needs a value"],
    [["--fixture", "--session", "session-a"], "--fixture needs a value"],
    [["--fixture", "first-run", "--session"], "--session needs a value"],
  ])("refuses %j", (launchArguments, refusal) => {
    expect(() => parseFixtureLaunch([...ELECTRON_ARGUMENTS, ...launchArguments])).toThrow(refusal);
  });
});

describe("checkFixtureLaunchAgainstCatalog", () => {
  it("accepts a scenario the catalog holds, alone or with its own session", async () => {
    await expect(
      checkFixtureLaunchAgainstCatalog({ scenarioId: FIRST_RUN_SCENARIO.id }),
    ).resolves.toBeUndefined();
    await expect(
      checkFixtureLaunchAgainstCatalog({
        scenarioId: CONCURRENT_STREAMING_SCENARIO.id,
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
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
        sessionId: CONCURRENT_STREAMING_SCENARIO.sessionId,
      }),
    ).rejects.toThrow(`not "${CONCURRENT_STREAMING_SCENARIO.sessionId}"`);
  });
});
