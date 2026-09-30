// Tier: end-to-end. Spec files are named for the incident they reproduce, not the module they
// touch. Every other tier renders the console into something that is not the application
// (happy-dom, or a Chromium page), so none catches a defect that exists only in the shipped
// app; this tier runs the path a person installing it would run.
//
// Playwright's own auto-retrying `expect` is not used: with two `expect`s, which timeout
// applies to a line is answered from the import list, and its web-assertion timeouts come from
// a test context this runner does not provide. Waiting is explicit (`locator.waitFor`,
// `expect.poll`) and asserting is Vitest's.
//
// The incident: `require` was reachable from the console. The hardening that keeps Node out of
// the renderer is a property of the build, and a build flavor is the axis along which it
// regresses. The smoke probe asserts this against the smoke bundle through stdout and this
// asserts it against the fixtures bundle the console tiers run; neither substitutes for the
// other.
//

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("end-to-end — node globals reached the renderer", () => {
  it("keeps the renderer free of Node globals", async () => {
    await withLaunchedApp({}, async (consoleApplication) => {
      // The smoke test asserts this against a `SIDEKICKS_SMOKE_PROBE` build; this covers the
      // fixtures bundle, so the two tests cover two bundles.
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
