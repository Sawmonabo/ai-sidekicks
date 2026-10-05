// The main process must open a window with the app in it. Two ways it can fail: the window is
// served from a scheme never registered as standard, so the document has no origin and the
// renderer boots into a storage error; or the bundle loads and the frame mounts but the
// composition is empty (no rail, no mounted screen, an unowned pane kind rendering as a hole
// rather than a placed empty state).

import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "../../fixtures/scenarios/first-run.js";
import { PANE_HARNESS_LABEL } from "@renderer/app/pane-harness/PaneHarnessFrame.js";
import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("end-to-end — app came up blank", () => {
  it("boots the frame with its rail, a mounted screen, and a placed empty state", async () => {
    // The scenario is named because every claim below is about the first-run composition (a
    // readable session, an unowned pane kind); a window naming no scenario plays the default
    // one and opens into it, and naming one stands that first-launch rule down.
    await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
      const appWindow = appUnderTest.window;

      // The rail rendered at all; which destinations exist is the route table's business, so this
      // reads a count, not labels.
      const railButtonCount = await appWindow.locator(".meridian-rail__button").count();
      expect(railButtonCount).toBeGreaterThan(0);

      // The sessions destination has an owner, the all-sessions screen: its section is present
      // and the frame's unowned-screen wrapper is not.
      await appWindow.locator(".meridian-frame").waitFor({
        state: "visible",
        timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      await appWindow.locator(".meridian-sessions").waitFor({
        state: "visible",
        timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      expect(await appWindow.locator(".meridian-screen-notice").count()).toBe(0);

      // The placed empty state, in a real window, is the half that gives the other half meaning:
      // without it, "no screen notice on sessions" would also pass over a frame that stopped
      // rendering that arm. It must be the placed one, because a bare line at the top-left is
      // what a half-painted page looks like.
      //
      // This is the harness's admission refusal. `registeredPaneKinds()` answers with every one of
      // `PANE_KINDS`, so no address in a built app reaches a reserved arm. What stands in is an
      // empty state no feature can claim away: `PaneHarnessScreen` holds the address segment to
      // `parsePaneAddress`, the app's one admission point for an untyped address, and a
      // segment naming no kind is refused there. It is also the stronger end-to-end subject, since
      // a mistyped hash is something a person does while a reserved arm is reachable only through
      // a composition mistake.
      //
      // Both address segments are required by the route's grammar, and the session is the
      // scenario's own, readable, which gets the store open and the route as far as the harness.
      await appWindow.evaluate((sessionId: string) => {
        window.location.hash = `#/pane-harness/not-a-pane-kind/${sessionId}`;
      }, FIRST_RUN_SCENARIO.sessionId);
      // `--block` is the placement, the other half of "not a bare line": this arm
      // renders its `Nothing` inside the harness region, where the placement modifier carries
      // the claim `ScreenNotice` carries at the screen layer.
      await appWindow
        .locator(
          `section[aria-label="${PANE_HARNESS_LABEL}"] ` +
            `.meridian-nothing--block.meridian-nothing--error`,
        )
        .waitFor({
          state: "visible",
          timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        });
    });
  });
});
