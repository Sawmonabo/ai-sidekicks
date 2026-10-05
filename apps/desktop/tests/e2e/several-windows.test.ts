// Several windows over one hidden console document. Every window a person sees is drawn by the
// console document's script, so closing one or minimizing another must not stop the others
// drawing, and while any window is open the app keeps running.

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { withLaunchedApp, type AppUnderTest } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch-body.js";

const bundleIsBuilt = fixtureBundleExists();

/** How long each window's frames are counted for. */
const FRAME_COUNT_SPAN_MS = 500;

/** Open a window from the console document, the way the console opens every window. */
async function openWindowFromConsole(appUnderTest: AppUnderTest, windowId: string): Promise<Page> {
  // Armed before the open, so a window that comes up mid-call is not missed.
  const opened = appUnderTest.application.waitForEvent("window", {
    timeout: appUnderTest.bodyAllowance.remainingMs(),
  });
  await appUnderTest.consolePage.evaluate((name: string) => {
    window.open("about:blank", name);
  }, windowId);
  return await opened;
}

/** How many frames a window draws over the counting span. */
async function countFrames(page: Page): Promise<number> {
  return await page.evaluate(
    async (spanMs: number) =>
      await new Promise<number>((resolve) => {
        let frames = 0;
        const onFrame = (): void => {
          frames += 1;
          requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);
        setTimeout(() => {
          resolve(frames);
        }, spanMs);
      }),
    FRAME_COUNT_SPAN_MS,
  );
}

describe.skipIf(!bundleIsBuilt)("end-to-end — several windows", () => {
  it("keeps drawing the windows left open after one closes and one minimizes", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const firstWindowId = await appUnderTest.window.evaluate(() => window.name);
      const second = await openWindowFromConsole(appUnderTest, "window/end-to-end-second");
      const third = await openWindowFromConsole(appUnderTest, "window/end-to-end-third");

      // Close the first window and minimize the second, each found by its frame name.
      const firstClosed = appUnderTest.window.waitForEvent("close", {
        timeout: appUnderTest.bodyAllowance.remainingMs(),
      });
      const reading = await appUnderTest.application.evaluate(
        async ({ BaseWindow, WebContentsView }, names) => {
          const byName = (name: string): Electron.BaseWindow | undefined =>
            BaseWindow.getAllWindows().find((baseWindow) =>
              baseWindow.contentView.children.some(
                (child) =>
                  child instanceof WebContentsView && child.webContents.mainFrame.name === name,
              ),
            );
          byName(names.first)?.close();
          const secondWindow = byName(names.second);
          // Minimizing finishes after the call returns, so the answer is read on its event.
          return await new Promise<{ isSecondMinimized: boolean }>((resolve) => {
            secondWindow?.once("minimize", () => {
              resolve({ isSecondMinimized: secondWindow.isMinimized() });
            });
            secondWindow?.minimize();
            setTimeout(() => {
              resolve({ isSecondMinimized: secondWindow?.isMinimized() ?? false });
            }, names.minimizeDeadlineMs);
          });
        },
        {
          first: firstWindowId,
          second: "window/end-to-end-second",
          minimizeDeadlineMs: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
        },
      );
      await firstClosed;

      expect(reading.isSecondMinimized).toBe(true);
      expect(await countFrames(second)).toBeGreaterThan(0);
      expect(await countFrames(third)).toBeGreaterThan(0);
      // The console document and the two windows left open; the app is still running.
      const windowCount = await appUnderTest.application.evaluate(
        ({ BaseWindow }) => BaseWindow.getAllWindows().length,
      );
      expect(windowCount).toBe(3);
      expect(appUnderTest.application.process().exitCode).toBeNull();
    });
  });
});
