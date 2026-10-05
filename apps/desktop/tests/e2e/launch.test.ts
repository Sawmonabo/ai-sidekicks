// The app launched as a person launches it: no scenario, so main's supervisor runs against a
// background service of the test's own. The console must come up as a `BaseWindow` showing the
// renderer bundle in one `WebContentsView` over the app's own scheme, and nothing may build a
// `BrowserWindow`. A window the renderer opens with `window.open` is main's own `BaseWindow`
// around a document that has no bridge: only the renderer's own page holds one. The renderer's own
// facts on that page (the bridge present, `require` absent) are the smoke tier's probe.

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron-harness.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";

const bundleIsBuilt = fixtureBundleExists();

/** What main holds once the first window is up, read inside the main process. */
interface MainWindowReading {
  readonly baseWindowCount: number;
  readonly browserWindowCount: number;
  readonly views: readonly { readonly isWebContentsView: boolean; readonly url: string }[];
}

describe.skipIf(!bundleIsBuilt)("end-to-end — launch", () => {
  it("opens the console as a BaseWindow with the bundle in a WebContentsView", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const reading: MainWindowReading = await appUnderTest.application.evaluate(
        ({ BaseWindow, BrowserWindow, WebContentsView }) => {
          const baseWindows = BaseWindow.getAllWindows();
          return {
            baseWindowCount: baseWindows.length,
            browserWindowCount: BrowserWindow.getAllWindows().length,
            views: baseWindows.flatMap((baseWindow) =>
              baseWindow.contentView.children.map((child) => ({
                isWebContentsView: child instanceof WebContentsView,
                url: child instanceof WebContentsView ? child.webContents.getURL() : "",
              })),
            ),
          };
        },
      );

      expect(reading.baseWindowCount).toBe(1);
      expect(reading.browserWindowCount, "a BrowserWindow was built").toBe(0);
      expect(reading.views).toEqual([
        { isWebContentsView: true, url: expect.stringMatching(/^sidekicks-renderer:\/\/app\//) },
      ]);
      // The page Playwright drives is that view's document.
      expect(appUnderTest.window.url()).toBe(reading.views[0]?.url);
    });
  });

  it("builds the renderer's own window.open child as a window whose document has no bridge", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const fromThePage = await appUnderTest.window.evaluate(() => {
        const child = window.open("about:blank", "window/end-to-end-child");
        const reading = {
          isOpened: child !== null,
          childBridge: typeof (child as unknown as { desktopBridge?: unknown } | null)
            ?.desktopBridge,
          ownBridge: typeof (window as unknown as { desktopBridge?: unknown }).desktopBridge,
        };
        return reading;
      });
      const baseWindowCount = await appUnderTest.application.evaluate(
        ({ BaseWindow }) => BaseWindow.getAllWindows().length,
      );

      expect(fromThePage).toEqual({
        isOpened: true,
        childBridge: "undefined",
        ownBridge: "object",
      });
      expect(baseWindowCount).toBe(2);
    });
  });
});
