// A window a person sees refuses a size under the floor its frame measures, at the default text
// size and at the largest: the console document hands main the floor box's size, main holds it as
// the window's minimum size, and a resize to anything smaller leaves the window at that minimum.
// The floor is read from the window's own layout, so a larger text size has to raise it.

import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import {
  type AppearanceRecord,
  DEFAULT_APPEARANCE_RECORD,
  TEXT_SIZES,
  type TextSize,
} from "#shared/appearance.js";
import type { PreloadApi } from "#shared/preload-api.js";
import { withLaunchedApp, type AppUnderTest } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

const LARGEST_TEXT_SIZE: TextSize = Math.max(...TEXT_SIZES) as TextSize;

/** A size in CSS px, which is the platform's px at the window's own zoom of one. */
interface Size {
  readonly width: number;
  readonly height: number;
}

/** What main holds for the window, and the size it keeps when asked for a smaller one. */
interface MainReading {
  readonly minimum: Size;
  readonly afterShrink: Size;
  readonly workArea: Size;
}

describe.skipIf(!bundleIsBuilt)("end-to-end — the window floor", () => {
  it("refuses a size under its floor at the default and the largest text size", async () => {
    await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
      await appUnderTest.window.locator(".meridian-frame__window-floor").waitFor({
        state: "attached",
        timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });

      const defaultFloor = await holdFloorAt(appUnderTest, DEFAULT_APPEARANCE_RECORD.textSize);
      const largestFloor = await holdFloorAt(appUnderTest, LARGEST_TEXT_SIZE);

      expect(largestFloor.width, "the width floor did not grow with the text").toBeGreaterThan(
        defaultFloor.width,
      );
      expect(largestFloor.height, "the height floor did not grow with the text").toBeGreaterThan(
        defaultFloor.height,
      );
    });
  });
});

/**
 * Chooses `textSize`, waits until main holds the floor the window then measures, and asks the
 * window for a size of one px square. Returns the floor measured; fails when main holds any other
 * minimum or the window ends up under it.
 */
async function holdFloorAt(appUnderTest: AppUnderTest, textSize: TextSize): Promise<Size> {
  await chooseTextSize(appUnderTest.consolePage, textSize);
  await expect
    .poll(async () => await readRootTextSize(appUnderTest.window), {
      timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      message: `the window did not take the ${String(textSize)} px text size`,
    })
    .toBe(`${String(textSize)}px`);
  const floor = await readFloorBox(appUnderTest.window);
  // The floor reaches main a moment after the layout settles.
  await expect
    .poll(async () => (await readMain(appUnderTest)).minimum, {
      timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      message: `main does not hold the floor at the ${String(textSize)} px text size`,
    })
    .toEqual(await expectedMinimum(appUnderTest, floor));

  const reading = await readMain(appUnderTest, { shrink: true });
  expect(reading.afterShrink, "the window took a size under its floor").toEqual(reading.minimum);
  return floor;
}

/** Asks main, from the console document, to keep the current appearance with `textSize`. */
async function chooseTextSize(consolePage: Page, textSize: TextSize): Promise<void> {
  await consolePage.evaluate(async (size) => {
    const windowBridge = (window as unknown as { desktopBridge: PreloadApi }).desktopBridge.window;
    // The subscription's first delivery is the record main keeps.
    const record = await new Promise<AppearanceRecord>((resolve) => {
      const stopHearing = windowBridge.subscribeAppearance((heard) => {
        queueMicrotask(stopHearing);
        resolve(heard);
      });
    });
    const { grounds, ...choice } = record;
    await windowBridge.setAppearance({ ...choice, textSize: size }, grounds);
  }, textSize);
}

/** The root font size the window's document computes. */
async function readRootTextSize(appWindow: Page): Promise<string> {
  return await appWindow.evaluate(() => getComputedStyle(document.documentElement).fontSize);
}

/** The floor box's size as the window's own layout sums it. */
async function readFloorBox(appWindow: Page): Promise<Size> {
  return await appWindow.evaluate(() => {
    const floorBox = document.querySelector(".meridian-frame__window-floor");
    if (floorBox === null) {
      throw new Error("The window has no floor box.");
    }
    const { width, height } = floorBox.getBoundingClientRect();
    return { width, height };
  });
}

/** The minimum main sets for `floor`: whole px rounded up, no larger than the display's work area. */
async function expectedMinimum(appUnderTest: AppUnderTest, floor: Size): Promise<Size> {
  const { workArea } = await readMain(appUnderTest);
  return {
    width: Math.min(Math.ceil(floor.width), workArea.width),
    height: Math.min(Math.ceil(floor.height), workArea.height),
  };
}

/**
 * Reads the one window a person sees from main: its minimum size, its display's work area and,
 * with `shrink`, the size it keeps after being asked for one px square.
 */
async function readMain(
  appUnderTest: AppUnderTest,
  options: { readonly shrink?: boolean } = {},
): Promise<MainReading> {
  return await appUnderTest.application.evaluate(
    ({ BaseWindow, WebContentsView, screen }, shrink) => {
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
      const [minimumWidth = 0, minimumHeight = 0] = baseWindow.getMinimumSize();
      if (shrink) {
        baseWindow.setSize(1, 1);
      }
      const [width = 0, height = 0] = baseWindow.getSize();
      const { workArea } = screen.getDisplayMatching(baseWindow.getBounds());
      return {
        minimum: { width: minimumWidth, height: minimumHeight },
        afterShrink: { width, height },
        workArea: { width: workArea.width, height: workArea.height },
      };
    },
    options.shrink ?? false,
  );
}
