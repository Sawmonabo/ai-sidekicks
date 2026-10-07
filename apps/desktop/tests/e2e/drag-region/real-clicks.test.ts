// A press on a control in the window's drag regions presses it, with the system's own pointer.
// The style the window computes says a control is cut out of the drag region; only the window
// server shows whether a real press reaches the page or moves the window. So on a Mac, with the
// window on screen and forward, this posts real mouse events: a click on a rail destination
// opens it, a double click on the session's title reaches the page, and neither moves, resizes
// or zooms the window. The negative control drags the rail's empty space, which moves it.
//
// It runs only on macOS and only when `SIDEKICKS_RUN_REAL_CLICKS=1` is set: it takes the pointer
// and focus from the person at the machine, and it needs the app running the test granted
// Accessibility to post events. CI never sets it. A run of this file alone:
//
//   SIDEKICKS_RUN_REAL_CLICKS=1 pnpm turbo run test:e2e --filter=@ai-sidekicks/desktop \
//     --concurrency=1 -- tests/e2e/drag-region/real-clicks.test.ts

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ElectronApplication, Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { formatRoute } from "#renderer/routing/routes.js";
import { withLaunchedApp, type AppUnderTest } from "../../helpers/electron/harness.js";
import { fixtureBundleExists } from "../../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../../helpers/launch/body.js";
import { TemporaryDirectoryTrail } from "../../helpers/temporary-directory.js";

const MOUSE_EVENTS_SOURCE = fileURLToPath(new URL("./mouse-events.swift", import.meta.url));

/** How far the negative control drags the rail, in screen points. */
const DRAG_OFFSET = { x: 60, y: 40 } as const;

const isOptedIn = process.platform === "darwin" && process.env["SIDEKICKS_RUN_REAL_CLICKS"] === "1";

/** A window's frame on the screen, in points. */
interface WindowFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the page's top-left corner sits on the screen, and the window's frame around it. */
interface WindowPlacement {
  readonly pageOrigin: { readonly x: number; readonly y: number };
  readonly frame: WindowFrame;
  readonly isMinimized: boolean;
}

const directories = new TemporaryDirectoryTrail();

afterEach(() => {
  directories.removeAll();
});

describe.skipIf(!fixtureBundleExists() || !isOptedIn)(
  "end-to-end — real clicks in the drag regions (macOS, SIDEKICKS_RUN_REAL_CLICKS=1)",
  () => {
    it("presses the rail's and the header's controls without moving the window, and drags from the rail's empty space", async () => {
      await withLaunchedApp(
        { scenarioId: FIRST_RUN_SCENARIO.id, isWindowOnScreen: true },
        async (appUnderTest) => {
          const mouseEvents = compileMouseEvents(appUnderTest);
          const appWindow = appUnderTest.window;
          await appWindow.evaluate(
            (hash: string) => {
              window.location.hash = hash;
            },
            formatRoute({ kind: "session", sessionId: FIRST_RUN_SCENARIO.sessionId }),
          );
          const title = appWindow.locator(".meridian-session-header__identity");
          await title.waitFor({
            state: "visible",
            timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          });
          await appWindow.evaluate(() => {
            const identity = document.querySelector(".meridian-session-header__identity");
            document.addEventListener("dblclick", (event) => {
              if (identity !== null && event.target instanceof Node) {
                document.documentElement.dataset["titleDoubleClicked"] = String(
                  identity.contains(event.target),
                );
              }
            });
          });
          const before = await readPlacement(appUnderTest.application);

          // The session's title: a double click in a drag region zooms the window.
          const titlePoint = await screenPointOf(
            appWindow,
            before,
            ".meridian-session-header__identity",
          );
          postMouseEvents(appUnderTest, mouseEvents, ["double-click", ...titlePoint]);
          await expect
            .poll(
              async () =>
                await appWindow.evaluate(
                  () => document.documentElement.dataset["titleDoubleClicked"],
                ),
              {
                timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
                message: "the double click on the title never reached the page",
              },
            )
            .toBe("true");
          expect(
            await readPlacement(appUnderTest.application),
            "the title moved the window",
          ).toEqual(before);

          // A rail destination: the press opens it.
          const settingsPoint = await screenPointOf(
            appWindow,
            before,
            ".meridian-rail__button[aria-label='Settings']",
          );
          postMouseEvents(appUnderTest, mouseEvents, ["click", ...settingsPoint]);
          await expect
            .poll(async () => await appWindow.evaluate(() => window.location.hash), {
              timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
              message: "the press on Settings did not open it",
            })
            .toBe(formatRoute({ kind: "settings", page: undefined }));
          expect(
            await readPlacement(appUnderTest.application),
            "the press on Settings moved the window",
          ).toEqual(before);

          // Negative control: the rail's empty space below its destinations drags the window.
          const emptyRailPoint = await appWindow.evaluate(() => {
            const rail = document.querySelector(".meridian-rail");
            const list = document.querySelector(".meridian-rail__list");
            if (rail === null || list === null) {
              throw new Error("The window has no rail with destinations in it.");
            }
            const railBox = rail.getBoundingClientRect();
            const listBox = list.getBoundingClientRect();
            return {
              x: railBox.left + railBox.width / 2,
              y: (listBox.bottom + railBox.bottom) / 2,
            };
          });
          postMouseEvents(appUnderTest, mouseEvents, [
            "drag",
            before.pageOrigin.x + emptyRailPoint.x,
            before.pageOrigin.y + emptyRailPoint.y,
            DRAG_OFFSET.x,
            DRAG_OFFSET.y,
          ]);
          // The system starts a window drag only past a small threshold, so the window follows
          // the pointer by less than the whole offset; it moves the way the pointer went.
          await expect
            .poll(
              async () => {
                const { frame } = await readPlacement(appUnderTest.application);
                return frame.x > before.frame.x && frame.y > before.frame.y;
              },
              {
                timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
                message: "dragging the rail's empty space did not move the window",
              },
            )
            .toBe(true);
          const dragged = await readPlacement(appUnderTest.application);
          expect(
            { width: dragged.frame.width, height: dragged.frame.height },
            "dragging the rail resized the window",
          ).toEqual({ width: before.frame.width, height: before.frame.height });
        },
      );
    });
  },
);

/** Builds the mouse-event program into a directory of this case's own, and answers its path. */
function compileMouseEvents(appUnderTest: AppUnderTest): string {
  const executable = path.join(directories.create("sidekicks-real-clicks-"), "mouse-events");
  const build = spawnSync("swiftc", [MOUSE_EVENTS_SOURCE, "-o", executable], {
    encoding: "utf8",
    timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });
  if (build.error !== undefined || build.status !== 0) {
    throw new Error(
      `swiftc did not build ${MOUSE_EVENTS_SOURCE}: ${build.error?.message ?? build.stderr}`,
    );
  }
  return executable;
}

/** Posts one gesture through the system's event tap, failing with the program's own words. */
function postMouseEvents(
  appUnderTest: AppUnderTest,
  executable: string,
  gesture: readonly [string, ...number[]],
): void {
  const posted = spawnSync(executable, gesture.map(String), {
    encoding: "utf8",
    timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
  });
  if (posted.error !== undefined || posted.status !== 0) {
    throw new Error(
      `mouse-events ${gesture.join(" ")} failed (exit ${String(posted.status)}): ` +
        `${posted.error?.message ?? posted.stderr}`,
    );
  }
}

/** The center of the element `selector` names, in screen points. */
async function screenPointOf(
  appWindow: Page,
  placement: WindowPlacement,
  selector: string,
): Promise<[number, number]> {
  const center = await appWindow.evaluate((elementSelector: string) => {
    const element = document.querySelector(elementSelector);
    if (element === null) {
      throw new Error(`Nothing in the window matches ${elementSelector}.`);
    }
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, selector);
  return [placement.pageOrigin.x + center.x, placement.pageOrigin.y + center.y];
}

/** The one window a person sees: its frame, and where its page starts on the screen. */
async function readPlacement(application: ElectronApplication): Promise<WindowPlacement> {
  return await application.evaluate(({ BaseWindow, WebContentsView }) => {
    const placements = BaseWindow.getAllWindows().flatMap((baseWindow) =>
      baseWindow.contentView.children
        .filter(
          (child) =>
            child instanceof WebContentsView &&
            child.webContents.getURL().startsWith("about:blank"),
        )
        .map((view) => {
          const content = baseWindow.getContentBounds();
          const viewBox = view.getBounds();
          return {
            pageOrigin: { x: content.x + viewBox.x, y: content.y + viewBox.y },
            frame: baseWindow.getBounds(),
            isMinimized: baseWindow.isMinimized(),
          };
        }),
    );
    const [placement] = placements;
    if (placements.length !== 1 || placement === undefined) {
      throw new Error(`Expected one window a person sees, found ${String(placements.length)}.`);
    }
    return placement;
  });
}
