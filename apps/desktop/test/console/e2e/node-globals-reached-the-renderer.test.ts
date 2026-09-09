// Tier: end-to-end — `Spec-023 §Console Test Tiers`, whose spec files are named for
// the incident they reproduce rather than for the module they touch.
//
// Every other console tier renders the console into something that is not the
// application: happy-dom for the unit tier, a Chromium page for the three browser-mode
// tiers. None of them can catch a defect that exists only in the shipped shell, and
// this tier runs the code path a person installing the application would run.
//
// ONE ASSERTION LIBRARY, DELIBERATELY. Playwright ships its own auto-retrying `expect`
// and it is not used here: mixing two `expect`s makes which timeout applies to a line
// a question a reader answers from the import list, and Playwright's web-assertion
// timeouts are read from a test context this runner does not provide. Waiting is
// explicit (`locator.waitFor`, `expect.poll`) and asserting is Vitest's.
//
// THE INCIDENT: `require` was reachable from the console.
//
// The hardening that keeps Node out of the renderer is a property of the BUILD, and a
// build flavour is exactly the axis along which it regresses: the Tier-1 smoke probe
// asserts this against the smoke bundle through stdout, and this asserts it against
// the fixtures bundle the console tiers run. The two cover two artifacts and neither
// substitutes for the other.
//

import { describe, expect, it } from "vitest";

import { withLaunchedConsole } from "../electron-harness.js";
import { fixtureBundleExists } from "../fixture-bundle.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("end-to-end — node globals reached the renderer", () => {
  it("keeps the renderer free of Node globals", async () => {
    await withLaunchedConsole({}, async (consoleApplication) => {
      // The Tier-1 smoke test asserts this against a `SIDEKICKS_SMOKE_PROBE`
      // build through a stdout probe. It is re-asserted here for a different
      // reason and against a different artifact: this is the FIXTURES bundle
      // running the console, and a console that reached for `require` would find
      // it in a build whose hardening had regressed. The two tests do not
      // duplicate each other — they cover two bundles.
      const leaks = await consoleApplication.window.evaluate(() => ({
        require: typeof (globalThis as Record<string, unknown>)["require"],
        process: typeof (globalThis as Record<string, unknown>)["process"],
        global: typeof (globalThis as Record<string, unknown>)["global"],
      }));
      expect(leaks).toStrictEqual({
        require: "undefined",
        process: "undefined",
        global: "undefined",
      });
    });
  });
});
