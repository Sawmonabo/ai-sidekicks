// Several windows over one hidden console document. Every window a person sees is drawn by the
// console document's script, so closing one or minimizing another must not stop the console
// drawing into the others, and while any window is open the app keeps running.
//
// The windows are opened the way the app opens them at start: the console document opens the
// window used last, then the rest of the kept window layout. The test keeps a layout of three
// windows and reloads the console document, so the console's own start opens all three.

import { describe, expect, it } from "vitest";

import { consoleWindowId } from "#shared/window/frame-name.js";
import { withLaunchedApp, type AppUnderTest } from "../helpers/electron/harness.js";
import { clickViewMenuScheme, readPageScheme } from "./color-scheme/access.js";
import { keepMoreWindows, reopenFromKeptLayout } from "./kept-windows.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";

const bundleIsBuilt = fixtureBundleExists();

/** How long each window's frames are counted for. */
const FRAME_COUNT_SPAN_MS = 500;

const SECOND_WINDOW_ID = consoleWindowId("end-to-end-second");
const THIRD_WINDOW_ID = consoleWindowId("end-to-end-third");

/**
 * How many frames a window hands the console document's script over the counting span, asked for
 * from the console's realm on the window it opened, as the console's frame clock asks for them.
 * Opening a name already open returns that window without navigating it.
 */
async function countFramesFromConsole(
  appUnderTest: AppUnderTest,
  windowId: string,
): Promise<number> {
  return await appUnderTest.consolePage.evaluate(
    async ({ name, spanMs }) => {
      const openWindow = window.open("", name);
      if (openWindow === null || openWindow.document.querySelector(".meridian-frame") === null) {
        throw new Error(`${name} is not a window the console drew`);
      }
      return await new Promise<number>((resolve) => {
        let frames = 0;
        const onFrame = (): void => {
          frames += 1;
          openWindow.requestAnimationFrame(onFrame);
        };
        openWindow.requestAnimationFrame(onFrame);
        setTimeout(() => {
          resolve(frames);
        }, spanMs);
      });
    },
    {
      name: windowId,
      spanMs: appUnderTest.bodyAllowance.boundedMs(FRAME_COUNT_SPAN_MS),
    },
  );
}

/** What main says of a window once a step has been taken on it. */
interface WindowStepReading {
  readonly isOpen: boolean;
  readonly isMinimized: boolean;
}

/**
 * Close or minimize the window drawn under frame `name`, in main, and read it once the step's
 * event arrives or one in-window step has passed. Both finish after the call returns, so the
 * reading waits for the event.
 */
async function stepWindowInMain(
  appUnderTest: AppUnderTest,
  name: string,
  step: "close" | "minimize",
): Promise<WindowStepReading> {
  return await appUnderTest.application.evaluate(
    async ({ BaseWindow, WebContentsView }, { frameName, windowStep, stepDeadlineMs }) => {
      const byName = (): Electron.BaseWindow | undefined =>
        BaseWindow.getAllWindows().find((baseWindow) =>
          baseWindow.contentView.children.some(
            (child) =>
              child instanceof WebContentsView && child.webContents.mainFrame.name === frameName,
          ),
        );
      const target = byName();
      if (target === undefined) {
        throw new Error(`no window shows a document named ${frameName}`);
      }
      return await new Promise<WindowStepReading>((resolve) => {
        const read = (): void => {
          const current = byName();
          resolve({ isOpen: current !== undefined, isMinimized: current?.isMinimized() ?? false });
        };
        if (windowStep === "close") {
          target.once("closed", read);
          target.close();
        } else {
          target.once("minimize", read);
          target.minimize();
        }
        setTimeout(read, stepDeadlineMs);
      });
    },
    {
      frameName: name,
      windowStep: step,
      stepDeadlineMs: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
    },
  );
}

describe.skipIf(!bundleIsBuilt)("end-to-end — several windows", () => {
  it("keeps drawing the windows left open after one closes and one minimizes", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const stepTimeout = (): number =>
        appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS);
      const firstWindowId = await appUnderTest.window.evaluate(() => window.name);
      await keepMoreWindows(appUnderTest, [SECOND_WINDOW_ID, THIRD_WINDOW_ID]);
      const windows = await reopenFromKeptLayout(appUnderTest, [
        firstWindowId,
        SECOND_WINDOW_ID,
        THIRD_WINDOW_ID,
      ]);
      const second = windows.get(SECOND_WINDOW_ID);
      const third = windows.get(THIRD_WINDOW_ID);
      if (second === undefined || third === undefined) {
        throw new Error("the reopened windows went missing");
      }

      // Close the first window, then minimize the second. On Linux a window minimizes only under
      // a window manager, which CI starts beside its X server.
      expect(await stepWindowInMain(appUnderTest, firstWindowId, "close")).toStrictEqual({
        isOpen: false,
        isMinimized: false,
      });
      expect(await stepWindowInMain(appUnderTest, SECOND_WINDOW_ID, "minimize")).toStrictEqual({
        isOpen: true,
        isMinimized: true,
      });

      // The console still draws the third window: its tree is mounted and its frames arrive.
      expect(await third.locator(".meridian-frame").count()).toBe(1);
      expect(await countFramesFromConsole(appUnderTest, THIRD_WINDOW_ID)).toBeGreaterThan(0);
      // The window draws its scroll bars through its own copy of the overlay scrollbar library; a
      // copy in the console document would never start them, since that page never paints.
      await expect
        .poll(
          async () =>
            await third.locator(".meridian-frame__screen[data-overlayscrollbars-viewport]").count(),
          { timeout: stepTimeout(), message: "the window drew no overlay scrollbar" },
        )
        .toBe(1);
      // The minimized window's frames are not asserted: Playwright's focus emulation holds every
      // page it drives visible, so here a minimized window keeps drawing, on Linux too with
      // Chromium's throttling switched back on. What holds either way is that the console still
      // holds it, below.

      // An app-wide change the console applies to every window it holds: the View menu's
      // scheme, clicked in main as a person's click runs it. A fresh profile carries none.
      expect(await readPageScheme(third)).toBeNull();
      expect(await readPageScheme(second)).toBeNull();
      const isClicked = await clickViewMenuScheme(appUnderTest, "Dark");
      expect(isClicked, "the View menu has a Dark row").toBe(true);
      for (const [name, page] of [
        ["the third window", third],
        ["the minimized second window", second],
      ] as const) {
        await expect
          .poll(async () => await readPageScheme(page), {
            timeout: stepTimeout(),
            message: `the console stopped drawing ${name}`,
          })
          .toBe("dark");
      }

      // The console document and the two windows left open; the app is still running.
      const windowCount = await appUnderTest.application.evaluate(
        ({ BaseWindow }) => BaseWindow.getAllWindows().length,
      );
      expect(windowCount).toBe(3);
      expect(appUnderTest.application.process().exitCode).toBeNull();
    });
  });
});
