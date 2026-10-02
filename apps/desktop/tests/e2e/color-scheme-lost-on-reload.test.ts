// The color scheme a person chose must survive a restart. The applied attribute is written
// synchronously and the durable record is not, so every layer above reports success while the
// bytes are in flight; only a reload separates a preference that was written from one merely
// readable in the window that wrote it.

import { describe, expect, it } from "vitest";

import {
  PERSISTENCE_GLOBAL_PARTITION,
  SCHEME_PREFERENCE_KEY,
} from "@renderer/store/persistence/persistence-adapter.js";
import {
  UI_STATE_DATABASE_NAME,
  UI_STATE_STORE_NAME,
} from "@renderer/store/persistence/indexeddb-persistence-adapter.js";
import { SCHEME_ATTRIBUTE } from "@renderer/styles/generate-css.js";
import { withLaunchedApp } from "../helpers/electron-harness.js";
import { openPalette } from "../helpers/palette-interaction.js";
import { fixtureBundleExists } from "../helpers/fixture-bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../helpers/launch-body.js";
import { READINESS_BUDGET_MS } from "../helpers/launch-budgets.js";
import { LaunchDeadline } from "../helpers/launch-deadline.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("end-to-end — color scheme lost on reload", () => {
  it("persists an explicit color scheme across a reload", async () => {
    await withLaunchedApp({}, async (appUnderTest) => {
      const appWindow = appUnderTest.window;
      const readScheme = async (): Promise<string | null> =>
        await appWindow.evaluate(
          (schemeAttribute) => document.documentElement.getAttribute(schemeAttribute),
          SCHEME_ATTRIBUTE,
        );

      // What is actually on disk, read through a second connection rather than the app's
      // own store. The names come from the modules that own them, so a rename breaks this at
      // compile time; the record shape is the adapter's `StoredRecord`, and only `value` is read.
      const readPersistedScheme = async (): Promise<string | null> =>
        await appWindow.evaluate(
          async ([databaseName, storeName, partition, key]) =>
            await new Promise<string | null>((resolve, reject) => {
              // A failed open or read rejects: read as `null` it would report the scheme as never
              // written and hide the real failure.
              const openRequest = indexedDB.open(databaseName);
              openRequest.onerror = (): void => {
                reject(openRequest.error ?? new Error(`could not open ${databaseName}`));
              };
              openRequest.onsuccess = (): void => {
                const database = openRequest.result;
                if (!database.objectStoreNames.contains(storeName)) {
                  // The app degraded to memory and this connection just created an empty
                  // database, so nothing is stored.
                  database.close();
                  resolve(null);
                  return;
                }
                const readRequest = database
                  .transaction(storeName)
                  .objectStore(storeName)
                  .get([partition, key]);
                readRequest.onerror = (): void => {
                  database.close();
                  reject(readRequest.error ?? new Error(`could not read ${storeName}`));
                };
                readRequest.onsuccess = (): void => {
                  const record = readRequest.result as { readonly value?: unknown } | undefined;
                  database.close();
                  resolve(typeof record?.value === "string" ? record.value : null);
                };
              };
            }),
          [
            UI_STATE_DATABASE_NAME,
            UI_STATE_STORE_NAME,
            PERSISTENCE_GLOBAL_PARTITION,
            SCHEME_PREFERENCE_KEY,
          ] as const,
        );

      // A fresh profile starts on "system", which writes no attribute so the sheet's
      // `prefers-color-scheme` layer keeps following the OS; a resolved value here would be the
      // defect.
      expect(await readScheme()).toBeNull();

      // Driven through the palette to prove the whole path a person takes (command, store,
      // chokepoint, IndexedDB), which a direct store call would not. The `Color scheme` row
      // moves to the next scheme in its cycle, and the one after "system" is dark.
      await openPalette(appUnderTest);
      await appWindow.keyboard.type("Color scheme");
      await appWindow.keyboard.press("Enter");
      await expect
        .poll(readScheme, {
          timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          message: "the scheme did not change",
        })
        .toBe("dark");

      // The reload waits for the bytes, not the paint; otherwise a database commit would race a
      // navigation and a lost preference would look like a broken feature.
      await expect
        .poll(readPersistedScheme, {
          timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          message: "the scheme was never written",
        })
        .toBe("dark");

      // The reload is the assertion: everything above could pass against state that lives only
      // in memory. IndexedDB is per-origin and this launch has its own profile, so the read is
      // this run's own write.
      //
      // The reload boots the renderer a second time, which `launch-readiness` bounds, so
      // the navigation and the frame element share one clock at that figure, as `launchApp`
      // divides its own ladder. Both legs are also held to what is left of the body's allowance.
      const reloadDeadline = new LaunchDeadline(READINESS_BUDGET_MS);
      await appWindow.reload({
        timeout: appUnderTest.bodyAllowance.boundedMs(reloadDeadline.remainingMs()),
      });
      await appWindow.waitForSelector(".meridian-frame", {
        timeout: appUnderTest.bodyAllowance.boundedMs(reloadDeadline.remainingMs()),
      });
      await expect
        .poll(readScheme, {
          timeout: appUnderTest.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          message: "the scheme did not survive a reload",
        })
        .toBe("dark");
    });
  });
});
