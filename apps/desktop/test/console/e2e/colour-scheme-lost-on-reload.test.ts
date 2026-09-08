// Tier: end-to-end — `Spec-023 §Console Test Tiers`, whose spec files are named for
// the incident they reproduce rather than for the module they touch.
//
// Every other console tier renders the console into something that is not the
// application: happy-dom for the unit tier, a Chromium page for the three browser-mode
// tiers. None of them can catch a defect that exists only in the shipped shell, and
// this tier runs the code path a person installing the application would run.
//
// ONE ASSERTION LIBRARY, DELIBERATELY. Playwright ships its own auto-retrying `expect`
// and it is not used here: mixing two `expect`s makes which timeout applies to a line
// a question a reader answers from the import list, and Playwright's web-assertion
// timeouts are read from a test context this runner does not provide. Waiting is
// explicit (`locator.waitFor`, `expect.poll`) and asserting is Vitest's.
//
// THE INCIDENT: the colour scheme a person chose was back to the default after a
// restart.
//
// The applied attribute is written synchronously and the durable record is not, so
// every layer above reports success while the bytes are still in flight — and the only
// observation that separates a preference that was WRITTEN from one that is merely
// readable in the window that wrote it is a reload.
//
// EVERY WAIT IS CHARGED TO THE BODY'S ALLOWANCE. `withLaunchedConsole` reserves an
// allowance for what runs between a settled launch and its cleanup, and a wait that
// ignored it would be bounded twice over with the wrong one winning: a poll declaring
// 10 000 ms against an allowance with 200 ms left runs past the allowance, and the
// outer race then replaces the poll's own message ("the scheme did not change") with
// the generic body-overrun sentence. So every bounded wait below is handed
// `bodyAllowance.boundedMs(<its own bound>)` — the smaller of the two — which is what
// makes the FIRST wait that cannot fit fail saying which step it was.
// `architecture/body-allowance-consumption.test.ts` reads this file and fails on a
// wait that names no allowance.
//

import { describe, expect, it } from "vitest";

import {
  PERSISTENCE_GLOBAL_PARTITION,
  SCHEME_PREFERENCE_KEY,
} from "../../../src/renderer/src/console/persistence/index.js";
import {
  CONSOLE_DATABASE_NAME,
  UI_STATE_STORE_NAME,
} from "../../../src/renderer/src/console/persistence/indexeddb-adapter.js";
import { withLaunchedConsole } from "../electron-harness.js";
import { openPalette } from "../palette-interaction.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../launch-body.js";
import { READINESS_BUDGET_MS } from "../launch-budgets.js";
import { LaunchDeadline } from "../launch-deadline.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("end-to-end — colour scheme lost on reload", () => {
  it("persists an explicit colour scheme across a reload", async () => {
    await withLaunchedConsole({}, async (consoleApplication) => {
      const consoleWindow = consoleApplication.window;
      const readScheme = async (): Promise<string | null> =>
        await consoleWindow.evaluate(
          () => document.documentElement.dataset["consoleScheme"] ?? null,
        );

      // What is actually ON DISK, read through a second connection rather than
      // through the console's own store.
      //
      // The names come from the modules that own them, so a renamed database or
      // key breaks this at compile time instead of turning the check vacuous. The
      // record shape is the adapter's `StoredRecord`; only its `value` is read.
      const readPersistedScheme = async (): Promise<string | null> =>
        await consoleWindow.evaluate(
          async ([databaseName, storeName, partition, key]) =>
            await new Promise<string | null>((resolve) => {
              const openRequest = indexedDB.open(databaseName);
              openRequest.onerror = (): void => {
                resolve(null);
              };
              openRequest.onsuccess = (): void => {
                const database = openRequest.result;
                if (!database.objectStoreNames.contains(storeName)) {
                  // The console degraded to memory and this connection just
                  // created an empty database. Nothing is stored; say so.
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
                  resolve(null);
                };
                readRequest.onsuccess = (): void => {
                  const record = readRequest.result as { readonly value?: unknown } | undefined;
                  database.close();
                  resolve(typeof record?.value === "string" ? record.value : null);
                };
              };
            }),
          [
            CONSOLE_DATABASE_NAME,
            UI_STATE_STORE_NAME,
            PERSISTENCE_GLOBAL_PARTITION,
            SCHEME_PREFERENCE_KEY,
          ] as const,
        );

      // A fresh profile starts on "system", and "system" writes NO attribute —
      // deliberately, so the sheet's `prefers-color-scheme` layer keeps following
      // the OS instead of freezing at whatever it was at mount. Asserted rather
      // than assumed: it is the state every first-run person is in, and a
      // resolved value written here would be the defect.
      expect(await readScheme()).toBeNull();

      // Driven through the palette rather than by calling the store, because the
      // durable write is the point: this proves the whole path a person takes —
      // command, store, chokepoint, IndexedDB — and a direct store call would
      // prove only that the store works, which the unit tier already knows.
      await openPalette(consoleApplication);
      await consoleWindow.keyboard.type("Use the dark colour scheme");
      await consoleWindow.keyboard.press("Enter");
      await expect
        .poll(readScheme, {
          timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          message: "the scheme did not change",
        })
        .toBe("dark");

      // The applied attribute is set synchronously and the durable write is not,
      // so the reload waits for the bytes rather than for the paint. Without this
      // the test would be racing a database commit against a navigation, and the
      // shape of losing that race is a lost preference reported as a broken
      // feature.
      await expect
        .poll(readPersistedScheme, {
          timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          message: "the scheme was never written",
        })
        .toBe("dark");

      // The reload is the assertion. Everything above could pass against state
      // that lives only in memory; only a reload distinguishes a preference that
      // was written from one that is merely readable in the window that wrote it.
      // IndexedDB is per-origin and this launch has its own profile, so the read
      // is of this run's own write.
      //
      // The reload boots the renderer a second time, which is the subject
      // `console-launch-readiness` bounds — so the navigation and the frame
      // element it must produce share ONE clock at that figure rather than
      // taking it each, exactly as `launchConsole` divides its own ladder. Both
      // legs are additionally held to what is left of the body's allowance, so
      // whichever runs out first is the one that names itself.
      const reloadDeadline = new LaunchDeadline(READINESS_BUDGET_MS);
      await consoleWindow.reload({
        timeout: consoleApplication.bodyAllowance.boundedMs(reloadDeadline.remainingMs()),
      });
      await consoleWindow.waitForSelector(".meridian-frame", {
        timeout: consoleApplication.bodyAllowance.boundedMs(reloadDeadline.remainingMs()),
      });
      await expect
        .poll(readScheme, {
          timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
          message: "the scheme did not survive a reload",
        })
        .toBe("dark");
    });
  });
});
