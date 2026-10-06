// The window's title bar in a real window. On macOS the console fills the window under the three
// traffic-light buttons, which the platform reports as the window-controls overlay; the rail is
// at least as wide as the buttons, its first destination starts below them, and both the width
// and the inset go in fullscreen, where the buttons go. Everywhere else the system's own strip
// stays and the rail keeps its own width with no inset. On every platform the rail and the
// session header are the window's drag regions, and the rail's buttons and the session's title
// are cut out of them.
//
// What this reads is the style the window's own document computes, not a native drag: no test
// here moves the pointer.

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { withLaunchedApp, type AppUnderTest } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

/** What Chromium's window-controls overlay answers; the DOM library does not declare it yet. */
interface WindowControlsOverlay {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

/** The rail's box, its first destination, and the traffic-light area, read in the window. */
interface RailReading {
  readonly overlayStart: number;
  readonly overlayHeight: number;
  readonly railWidth: number;
  readonly isOverlayVisible: boolean;
  readonly firstButtonTop: number;
  readonly paddingTop: string;
  readonly paddingBottom: string;
}

describe.skipIf(!bundleIsBuilt)("end-to-end — the title bar", () => {
  it("keeps the rail's destinations clear of the traffic lights, and drops the room in fullscreen", async () => {
    await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
      const appWindow = appUnderTest.window;
      await appWindow
        .locator(".meridian-rail__button")
        .first()
        .waitFor({
          state: "visible",
          timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        });
      const windowed = await readRail(appWindow);

      // CI runs on Linux, so the macOS half below runs only on a local Mac.
      if (process.platform !== "darwin") {
        expect(windowed.isOverlayVisible, "a title-bar overlay off macOS").toBe(false);
        expect(windowed.paddingTop, "the rail carries an inset off macOS").toBe(
          windowed.paddingBottom,
        );
        return;
      }

      expect(windowed.isOverlayVisible, "the traffic lights are not reported").toBe(true);
      expect(windowed.overlayHeight).toBeGreaterThan(0);
      expect(
        windowed.overlayStart,
        "the overlay reports no start past the buttons",
      ).toBeGreaterThan(0);
      expect(
        windowed.railWidth,
        "the rail is narrower than the traffic lights",
      ).toBeGreaterThanOrEqual(windowed.overlayStart);
      expect(windowed.paddingTop).toBe(`${String(windowed.overlayHeight)}px`);
      expect(
        windowed.firstButtonTop,
        "the first destination starts under the traffic lights",
      ).toBeGreaterThanOrEqual(windowed.overlayHeight);

      // The overlay's change reaches the document a moment after the platform's event.
      await setFullScreen(appUnderTest, true);
      await expect
        .poll(async () => (await readRail(appWindow)).isOverlayVisible, {
          timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          message: "the traffic lights stay reported in fullscreen",
        })
        .toBe(false);
      const fullscreen = await readRail(appWindow);
      expect(fullscreen.paddingTop, "the inset stays in fullscreen").toBe(fullscreen.paddingBottom);
      expect(fullscreen.firstButtonTop).toBeLessThan(windowed.firstButtonTop);
      expect(fullscreen.railWidth, "the rail stays widened in fullscreen").toBeLessThan(
        windowed.railWidth,
      );

      await setFullScreen(appUnderTest, false);
      await expect
        .poll(async () => await readRail(appWindow), {
          timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          message: "the inset did not come back on leaving fullscreen",
        })
        .toEqual(windowed);
    });
  });

  it("makes the rail and the session header drag regions, with their controls and the title cut out", async () => {
    await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
      const appWindow = appUnderTest.window;
      await appWindow.evaluate(
        (hash: string) => {
          window.location.hash = hash;
        },
        formatRoute({ kind: "session", sessionId: FIRST_RUN_SCENARIO.sessionId }),
      );
      await appWindow.locator(".meridian-session-header__identity").waitFor({
        state: "visible",
        timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });

      const regions = await appWindow.evaluate(() => {
        const appRegionOf = (selector: string): string => {
          const element = document.querySelector(selector);
          if (element === null) {
            throw new Error(`Nothing in the window matches ${selector}.`);
          }
          return getComputedStyle(element).getPropertyValue("app-region");
        };
        return {
          rail: appRegionOf(".meridian-rail"),
          railButton: appRegionOf(".meridian-rail__button"),
          header: appRegionOf(".meridian-session-header"),
          title: appRegionOf(".meridian-session-header__identity"),
        };
      });

      expect(regions).toEqual({
        rail: "drag",
        railButton: "no-drag",
        header: "drag",
        title: "no-drag",
      });
    });
  });
});

/** The rail and the traffic-light area as the window's own document lays them out. */
async function readRail(appWindow: Page): Promise<RailReading> {
  return await appWindow.evaluate(() => {
    const rail = document.querySelector(".meridian-rail");
    const firstButton = document.querySelector(".meridian-rail__button");
    if (rail === null || firstButton === null) {
      throw new Error("The window has no rail with a destination in it.");
    }
    // A Chromium without the overlay API reports no overlay, as one with it does off macOS.
    const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay })
      .windowControlsOverlay;
    const railStyle = getComputedStyle(rail);
    const titlebarArea = overlay?.getTitlebarAreaRect();
    return {
      overlayStart: titlebarArea?.x ?? 0,
      overlayHeight: titlebarArea?.height ?? 0,
      railWidth: rail.getBoundingClientRect().width,
      isOverlayVisible: overlay?.visible ?? false,
      firstButtonTop: firstButton.getBoundingClientRect().top,
      paddingTop: railStyle.paddingTop,
      paddingBottom: railStyle.paddingBottom,
    };
  });
}

/**
 * Puts the window a person sees into or out of fullscreen and waits for the platform's event,
 * failing with its own sentence when the event does not come within one in-window step.
 */
async function setFullScreen(appUnderTest: AppUnderTest, isFullScreen: boolean): Promise<void> {
  await appUnderTest.application.evaluate(
    async ({ BaseWindow, WebContentsView }, { wantsFullScreen, timeoutMs }) => {
      const shown = BaseWindow.getAllWindows().filter((baseWindow) =>
        baseWindow.contentView.children.some(
          (child) =>
            child instanceof WebContentsView &&
            child.webContents.getURL().startsWith("about:blank"),
        ),
      );
      const [baseWindow] = shown;
      if (shown.length !== 1 || baseWindow === undefined) {
        throw new Error(`Expected one window a person sees, found ${String(shown.length)}.`);
      }
      let timer: NodeJS.Timeout | undefined;
      const settled = new Promise<void>((resolve, reject) => {
        if (wantsFullScreen) {
          baseWindow.once("enter-full-screen", resolve);
        } else {
          baseWindow.once("leave-full-screen", resolve);
        }
        timer = setTimeout(() => {
          reject(
            new Error(
              `the window did not ${wantsFullScreen ? "enter" : "leave"} fullscreen within ` +
                `${String(timeoutMs)} ms`,
            ),
          );
        }, timeoutMs);
      });
      baseWindow.setFullScreen(wantsFullScreen);
      try {
        await settled;
      } finally {
        clearTimeout(timer);
      }
    },
    {
      wantsFullScreen: isFullScreen,
      timeoutMs: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
    },
  );
}
