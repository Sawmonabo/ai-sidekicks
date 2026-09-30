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
// The incident: the main process opened a window and the console was not in it. Two shapes:
// the window is served from a scheme never registered as standard, so the document has no
// origin and the renderer boots into a storage error; or the bundle loads and the frame mounts
// but the composition is empty (no rail, no mounted screen, an unowned pane kind rendering as
// a hole rather than a composed absence).
//

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "../../fixtures/scenarios/first-run.js";
import { PANE_HARNESS_LABEL } from "@renderer/app/pane-harness/PaneHarnessFrame.js";
import { withLaunchedApp } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch-body.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("end-to-end — console came up blank", () => {
  it("boots the frame with its rail, a mounted screen, and a composed absence", async () => {
    // The scenario is named because every claim below is about the first-run composition (a
    // readable session, an unowned pane kind); a window naming no scenario plays the default
    // one and opens into it, and naming one stands that first-launch rule down.
    await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (consoleApplication) => {
      const consoleWindow = consoleApplication.window;

      // The rail rendered at all; which destinations exist is the route table's business, so this
      // reads a count, not labels.
      const railButtonCount = await consoleWindow.locator(".meridian-rail__button").count();
      expect(railButtonCount).toBeGreaterThan(0);

      // The sessions destination has an owner, the all-sessions screen: its section is present
      // and the frame's unowned-screen wrapper is not.
      await consoleWindow.locator(".meridian-frame").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      await consoleWindow.locator(".meridian-sessions").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      expect(await consoleWindow.locator(".meridian-screen-notice").count()).toBe(0);

      // The composed absence, in a real window, is the half that gives the other half meaning:
      // without it, "no absence wrapper on sessions" would also pass over a frame that stopped
      // rendering that arm. It must be the composed one, because a bare line at the top-left is
      // what a half-painted page looks like.
      //
      // This is the harness's admission refusal. `registeredPaneKinds()` answers with every one of
      // `PANE_KINDS`, so no address in a built console reaches a reserved arm. What stands in is an
      // absence no feature can claim away: `PaneHarnessScreen` holds the address segment to
      // `parsePaneAddress`, the console's one admission point for an untyped address, and a
      // segment naming no kind is refused there. It is also the stronger end-to-end subject, since
      // a mistyped hash is something a person does while a reserved arm is reachable only through
      // a composition mistake. The reserved arms stay pinned where a registry with no descriptor
      // can drive them: `PaneHarnessScreen.test.tsx` and `app/router.test.tsx`.
      //
      // Both address segments are required by the route's grammar, and the session is the
      // scenario's own, readable, which gets the store open and the route as far as the harness.
      await consoleWindow.evaluate((sessionId: string) => {
        window.location.hash = `#/pane-harness/not-a-pane-kind/${sessionId}`;
      }, FIRST_RUN_SCENARIO.sessionId);
      // `--block` is the composed placement, the other half of "not a bare line": this arm
      // renders its `Nothing` inside the harness region, where the placement modifier carries
      // the claim `ScreenNotice` carries at the screen layer.
      await consoleWindow
        .locator(
          `section[aria-label="${PANE_HARNESS_LABEL}"] .meridian-nothing--block.meridian-nothing--error`,
        )
        .waitFor({
          state: "visible",
          timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        });
    });
  });
});
