// A launch whose main process stops before any window opens fails in main's own words. It runs
// against the smoke bundle, which carries no scenarios like every build but the development and
// fixtures ones, so asking it for one makes main refuse the launch and exit; Playwright alone would
// say only that its page or browser had closed.

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO_ID } from "#fixtures/scenarios/first-run.js";

import { withLaunchedApp } from "./helpers/electron/harness.js";
import { BODY_ALLOWANCE_MS } from "./helpers/launch/budgets.js";
import { tierTimeoutFor } from "./helpers/launch/deadline.js";

describe("a launch main refuses", () => {
  it(
    "fails with main's own message and exit code, Playwright's error as its cause",
    async () => {
      const failure: unknown = await withLaunchedApp(
        { scenarioId: FIRST_RUN_SCENARIO_ID },
        async () => {
          throw new Error("the build played a scenario it does not carry");
        },
      ).then(
        () => expect.fail("the launch came up"),
        (rejection: unknown) => rejection,
      );

      expect(failure).toBeInstanceOf(Error);
      const { message, cause } = failure as Error;
      // Main's log entry, in a shape only the log holds: stderr prints `Error: ` before it.
      expect(message).toContain(
        "startup failed: --fixture needs a development or fixtures build, and this build " +
          "carries no scenarios",
      );
      expect(message).toContain("main exited with code 1");
      // The last line main's process writes, after the handover, as its inspector lets go.
      expect(message).toMatch(
        /since the launch handed it over:\n(?:.*\n)*.*Waiting for the debugger to disconnect/,
      );
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message).toContain("has been closed");
    },
    tierTimeoutFor(BODY_ALLOWANCE_MS),
  );
});
