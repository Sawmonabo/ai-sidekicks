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
  /** The URL of every document no window's view hosts. */
  readonly unhostedDocumentUrls: readonly string[];
}

describe.skipIf(!bundleIsBuilt)("end-to-end — launch", () => {
  // A `BrowserWindow` owns a never-navigated document of its own, a mute target in the debugger's
  // list that a client attaching to the app blocks on; every document in a view of a `BaseWindow`
  // leaves no such target.
  it("hosts every document in a view of a BaseWindow, leaving no mute debugger target", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const reading: MainWindowReading = await appUnderTest.application.evaluate(
        ({ BaseWindow, BrowserWindow, WebContentsView, webContents }) => {
          const windows = BaseWindow.getAllWindows().map((baseWindow) => baseWindow.contentView);
          const hostedIds = new Set(
            windows.flatMap((contentView) =>
              contentView.children.flatMap((child) =>
                child instanceof WebContentsView ? [child.webContents.id] : [],
              ),
            ),
          );
          return {
            browserWindowCount: BrowserWindow.getAllWindows().length,
            windows: windows.map((contentView) => ({
              views: contentView.children.map((child) => ({
                isWebContentsView: child instanceof WebContentsView,
                url: child instanceof WebContentsView ? child.webContents.getURL() : "",
              })),
            })),
            unhostedDocumentUrls: webContents
              .getAllWebContents()
              .filter((contents) => !hostedIds.has(contents.id))
              .map((contents) => contents.getURL()),
          };
        },
      );

      expect(reading.browserWindowCount, "a BrowserWindow was built").toBe(0);
      expect(reading.unhostedDocumentUrls, "a document no view hosts").toEqual([]);
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
