// A pane dragged by its header lands in its new place in the first window a person sees and in a
// second one, through the real window, its own document and a real pointer: the drag listens on
// the window the pane is drawn in, so a listener bound to the console document would hear
// nothing in either. Both windows show one session whose kept layout holds two panes.

import type { Page } from "playwright";
import { describe, expect, it } from "vitest";

import { FIRST_RUN_SCENARIO } from "#fixtures/scenarios/first-run.js";
import { PANE_LAYOUT_RECORD_KEY } from "#renderer/features/sessions/pane-layout/persistence.js";
import { PaneLayoutStore } from "#renderer/features/sessions/pane-layout/store.js";
import { formatRoute } from "#renderer/routing/routes.js";
import {
  UI_STATE_DATABASE_NAME,
  UI_STATE_STORE_NAME,
} from "#renderer/store/persistence/indexeddb-adapter.js";
import { consoleWindowId } from "#shared/window/frame-name.js";
import { withLaunchedApp, type AppUnderTest } from "../helpers/electron/harness.js";
import { fixtureBundleExists } from "../helpers/fixture/bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";
import { keepMoreWindows, reopenFromKeptLayout } from "./kept-windows.js";

const bundleIsBuilt = fixtureBundleExists();

const SECOND_WINDOW_ID = consoleWindowId("end-to-end-pane-drag");

/** The panes along the row, as the kind each one's frame names. */
const ROW_PANES = ".meridian-pane-layout__row .meridian-pane";

/**
 * Keep, for the scenario's session, the inspector then Sidekicks along the row: two panes narrow
 * enough to stand beside the conversation without the block scrolling.
 */
async function keepTwoPanes(appUnderTest: AppUnderTest): Promise<void> {
  const layout = new PaneLayoutStore();
  layout.open({ kind: "inspector", entity: { kind: "worktree", id: "worktree-01" } });
  layout.open({ kind: "agents" });
  const record = {
    partition: FIRST_RUN_SCENARIO.sessionId,
    key: PANE_LAYOUT_RECORD_KEY,
    valueClass: "layout",
    value: layout.toSnapshot(),
    updatedAt: Date.now(),
  };
  await appUnderTest.consolePage.evaluate(
    async ({ databaseName, storeName, stored }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("the UI-state database did not open"));
        };
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const write = database
            .transaction(storeName, "readwrite")
            .objectStore(storeName)
            .put(stored);
          write.onsuccess = () => {
            resolve();
          };
          write.onerror = () => {
            reject(write.error ?? new Error("the pane layout did not write"));
          };
        });
      } finally {
        database.close();
      }
    },
    { databaseName: UI_STATE_DATABASE_NAME, storeName: UI_STATE_STORE_NAME, stored: record },
  );
}

/** The kinds along the row in `appWindow`, in order, read off each frame's kind class. */
async function rowKinds(appWindow: Page): Promise<readonly string[]> {
  return await appWindow.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map(
        (frame) =>
          [...frame.classList]
            .find((name) => name.startsWith("meridian-pane--"))
            ?.slice("meridian-pane--".length) ?? "",
      ),
    ROW_PANES,
  );
}

/** Shows the session in `appWindow` and waits until it has drawn the two kept panes. */
async function showSession(appUnderTest: AppUnderTest, appWindow: Page): Promise<void> {
  await appWindow.evaluate(
    (hash) => {
      window.location.hash = hash;
    },
    formatRoute({ kind: "session", sessionId: FIRST_RUN_SCENARIO.sessionId }),
  );
  await expect
    .poll(async () => (await rowKinds(appWindow)).length, {
      timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      message: "the window did not restore the kept panes",
    })
    .toBe(2);
}

/**
 * Drags the second pane along the row by its header to the first pane's start, with the pointer
 * the platform delivers.
 */
async function dragSecondPaneFirst(appWindow: Page): Promise<void> {
  const { first, second, visibleRight } = await appWindow.evaluate((selector) => {
    const headBoxOf = (frame: Element): { x: number; y: number; width: number } => {
      const head = frame.querySelector(".meridian-pane__head");
      if (head === null) {
        throw new Error("a pane drew no header");
      }
      const box = head.getBoundingClientRect();
      return { x: box.left, y: box.top + box.height / 2, width: box.width };
    };
    const block = document.querySelector(".meridian-pane-layout__block");
    if (block === null) {
      throw new Error("the window drew no block of panes");
    }
    const [firstFrame, secondFrame] = [...document.querySelectorAll(selector)];
    if (firstFrame === undefined || secondFrame === undefined) {
      throw new Error("the window drew fewer than two panes");
    }
    return {
      first: headBoxOf(firstFrame),
      second: headBoxOf(secondFrame),
      // A narrow window scrolls the block, so the second header may run past what is shown.
      visibleRight: Math.min(block.getBoundingClientRect().right, window.innerWidth),
    };
  }, ROW_PANES);
  // The drag lands the pane where its own middle is carried, so it is pressed at its header's
  // middle where that is shown, clear of the controls at the header's end, and let go near the
  // first pane's start.
  const pressX = Math.min(second.x + second.width / 2, visibleRight - 24);
  const dropX = first.x + 8;
  await appWindow.mouse.move(pressX, second.y);
  await appWindow.mouse.down();
  await appWindow.mouse.move(dropX, second.y, { steps: 12 });
  await appWindow.mouse.up();
}

describe.skipIf(!bundleIsBuilt)("end-to-end — dragging a pane by its header", () => {
  it("lands the pane in its new place in a first window and in a second", async () => {
    await withLaunchedApp({ scenarioId: FIRST_RUN_SCENARIO.id }, async (appUnderTest) => {
      const firstWindowId = await appUnderTest.window.evaluate(() => window.name);
      await keepMoreWindows(appUnderTest, [SECOND_WINDOW_ID]);
      await keepTwoPanes(appUnderTest);
      const windows = await reopenFromKeptLayout(appUnderTest, [firstWindowId, SECOND_WINDOW_ID]);

      for (const windowId of [firstWindowId, SECOND_WINDOW_ID]) {
        const appWindow = windows.get(windowId);
        if (appWindow === undefined) {
          throw new Error(`the window ${windowId} did not reopen`);
        }
        await showSession(appUnderTest, appWindow);
        // Read here rather than assumed: the first window's drag is saved before the second
        // window's turn.
        const [firstKind, secondKind] = await rowKinds(appWindow);
        await dragSecondPaneFirst(appWindow);
        await expect
          .poll(async () => await rowKinds(appWindow), {
            timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
            message: `the drag did not move the pane in ${windowId}`,
          })
          .toStrictEqual([secondKind, firstKind]);
      }
    });
  });
});
