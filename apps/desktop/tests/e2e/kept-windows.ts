// The window layout the console keeps, edited from the console page, and a reload of the console
// document that opens every kept window the way the app's own start opens them.

import type { Page } from "playwright";
import { expect } from "vitest";

import { PERSISTENCE_GLOBAL_PARTITION } from "#renderer/store/persistence/adapter.js";
import {
  UI_STATE_DATABASE_NAME,
  UI_STATE_STORE_NAME,
} from "#renderer/store/persistence/indexeddb-adapter.js";
import { KEPT_WINDOWS_KEY } from "#renderer/store/window/layout/kept.js";
import type { AppUnderTest } from "../helpers/electron/harness.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch/body.js";
import { READINESS_BUDGET_MS } from "../helpers/launch/budgets.js";
import { LaunchDeadline } from "../helpers/launch/deadline.js";

/** Where the console reads and writes its UI state, handed into the console page. */
const KEPT_LAYOUT_ADDRESS = {
  databaseName: UI_STATE_DATABASE_NAME,
  storeName: UI_STATE_STORE_NAME,
  key: [PERSISTENCE_GLOBAL_PARTITION, KEPT_WINDOWS_KEY],
};

/**
 * Add `windowIds` after the windows in the layout the console kept, as if they had been open at
 * the last quit. Waits for the console's own record, so the entry shape is the console's.
 */
export async function keepMoreWindows(
  appUnderTest: AppUnderTest,
  windowIds: readonly string[],
): Promise<void> {
  await expect
    .poll(async () => await readKeptLayout(appUnderTest), {
      timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      message: "the console kept no window layout",
    })
    .toBeDefined();
  await editKeptLayout(appUnderTest, windowIds);
}

/** The window layout the console kept, or `undefined` before it has kept one. */
async function readKeptLayout(appUnderTest: AppUnderTest): Promise<unknown> {
  return await editKeptLayout(appUnderTest, []);
}

/**
 * The window layout the console kept, or `undefined` before it has kept one, read in the console
 * page; `added` windows are written after the kept ones, each shaped as the first kept entry.
 */
async function editKeptLayout(
  appUnderTest: AppUnderTest,
  added: readonly string[],
): Promise<unknown> {
  return await appUnderTest.consolePage.evaluate(
    async ({ address, windowIds }) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(address.databaseName);
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("the UI-state database did not open"));
        };
      });
      try {
        const store = database
          .transaction(address.storeName, windowIds.length > 0 ? "readwrite" : "readonly")
          .objectStore(address.storeName);
        const record = await new Promise<{ value: Record<string, object> } | undefined>(
          (resolve, reject) => {
            const read = store.get(address.key);
            read.onsuccess = () => {
              resolve(read.result as { value: Record<string, object> } | undefined);
            };
            read.onerror = () => {
              reject(read.error ?? new Error("the kept layout did not read"));
            };
          },
        );
        if (record === undefined || windowIds.length === 0) {
          return record?.value;
        }
        const kept = Object.values(record.value);
        const value = { ...record.value };
        windowIds.forEach((windowId, index) => {
          value[windowId] = { ...kept[0], order: kept.length + index };
        });
        await new Promise<void>((resolve, reject) => {
          const write = store.put({ ...record, value });
          write.onsuccess = () => {
            resolve();
          };
          write.onerror = () => {
            reject(write.error ?? new Error("the kept layout did not write"));
          };
        });
        return record.value;
      } finally {
        database.close();
      }
    },
    { address: KEPT_LAYOUT_ADDRESS, windowIds: added },
  );
}

/**
 * Reload the console document and hand back every window its start opened, by window id, each
 * drawn into. The reload boots the renderer again, so its legs share one readiness deadline.
 */
export async function reopenFromKeptLayout(
  appUnderTest: AppUnderTest,
  windowIds: readonly string[],
): Promise<Map<string, Page>> {
  const reloadDeadline = new LaunchDeadline(READINESS_BUDGET_MS);
  const legTimeout = (): number =>
    appUnderTest.bodyAllowance.boundedMs(reloadDeadline.remainingMs());
  await appUnderTest.consolePage.reload({ timeout: legTimeout() });
  const opened = new Map<string, Page>();
  await expect
    .poll(
      async () => {
        // The window the old console document drew shares the first window's name until main
        // closes it with that document, so it is never taken for the one reopened.
        const staleWindow = appUnderTest.window;
        for (const page of appUnderTest.application.windows()) {
          if (!page.isClosed() && page !== appUnderTest.consolePage && page !== staleWindow) {
            opened.set(await page.evaluate(() => window.name), page);
          }
        }
        return windowIds.filter((windowId) => !opened.has(windowId));
      },
      { timeout: legTimeout(), message: "the console's start did not open every kept window" },
    )
    .toStrictEqual([]);
  for (const windowId of windowIds) {
    await opened.get(windowId)?.waitForSelector(".meridian-frame", { timeout: legTimeout() });
  }
  return opened;
}
