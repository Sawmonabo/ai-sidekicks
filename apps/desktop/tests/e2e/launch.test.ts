// The app launched as a person launches it: no scenario, so main's supervisor runs against a
// background service of the test's own. Main builds the hidden console document as a `BaseWindow`
// showing the renderer bundle in one `WebContentsView` over the app's own scheme, never shown, and
// the console document opens the window a person sees with `window.open`: main's own `BaseWindow`
// around a document that has no bridge, since only the console document holds one. Nothing may
// build a `BrowserWindow`. The console document's own facts (the bridge present, `require` absent)
// are the smoke tier's probe.

import { describe, expect, it } from "vitest";

import { withLaunchedApp } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";

const bundleIsBuilt = fixtureBundleExists();

/** What main holds once the first window is up, read inside the main process. */
interface MainWindowReading {
  readonly browserWindowCount: number;
  readonly windows: readonly {
    readonly views: readonly { readonly isWebContentsView: boolean; readonly url: string }[];
  }[];
}

describe.skipIf(!bundleIsBuilt)("end-to-end — launch", () => {
  it("builds the hidden console document and the window it opens, each a BaseWindow", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const reading: MainWindowReading = await appUnderTest.application.evaluate(
        ({ BaseWindow, BrowserWindow, WebContentsView }) => ({
          browserWindowCount: BrowserWindow.getAllWindows().length,
          windows: BaseWindow.getAllWindows().map((baseWindow) => ({
            views: baseWindow.contentView.children.map((child) => ({
              isWebContentsView: child instanceof WebContentsView,
              url: child instanceof WebContentsView ? child.webContents.getURL() : "",
            })),
          })),
        }),
      );

      expect(reading.browserWindowCount, "a BrowserWindow was built").toBe(0);
      const consoleUrl = expect.stringMatching(/^sidekicks-renderer:\/\/app\//);
      expect(reading.windows).toEqual(
        expect.arrayContaining([
          // A test launch shows no window on macOS, so the two are told apart by document.
          { views: [{ isWebContentsView: true, url: consoleUrl }] },
          { views: [{ isWebContentsView: true, url: expect.stringMatching(/^about:blank/) }] },
        ]),
      );
      expect(reading.windows).toHaveLength(2);
      // The pages Playwright drives are those two documents.
      expect(appUnderTest.consolePage.url()).toMatch(/^sidekicks-renderer:\/\/app\//);
      expect(appUnderTest.window.url()).toMatch(/^about:blank/);
    });
  });

  it("builds the console document's window.open child as a window whose document has no bridge", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const fromThePage = await appUnderTest.consolePage.evaluate(() => {
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
      // The console window, the window it opened at start, and this one.
      expect(baseWindowCount).toBe(3);
    });
  });
});
