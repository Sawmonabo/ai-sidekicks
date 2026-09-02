// Tier: end-to-end — `Spec-023 §Console Test Tiers`.
//
// Every other console tier renders the console into something that is not the
// application: happy-dom for the unit tier, a Chromium page for the three
// browser-mode tiers. Each of those is a real check of something, and none of
// them can catch the class of defect that only exists in the shipped shell — a
// preload that did not register, a Content-Security-Policy header that blocks the
// bundle, a privileged scheme registered after `app.ready`, a renderer that boots
// against the live bridge and finds nothing. Those are the failures a person
// installing the application would hit first, and this is the only tier that runs
// the code path they would run.
//
// So the assertions here are deliberately about the SEAMS rather than about the
// console's behaviour. Whether the palette filters correctly is settled in the
// unit tier against a thousand cases in milliseconds; repeating one of those
// through a real Electron process would cost seconds to learn less. What this
// tier asks is narrower and unavailable anywhere else: did the shell hand the
// renderer a working window, did the hardening survive, does a keystroke reach
// the frame, and does the frame's own state survive a reload.
//
// ONE ASSERTION LIBRARY, DELIBERATELY
//
// Playwright ships its own auto-retrying `expect`, and it is not used here.
// Mixing two `expect`s in one file makes which timeout applies to a given line a
// question a reader has to answer from the import list — and Playwright's
// web-assertion timeouts are read from a test context this runner does not
// provide, so they would silently be the library default rather than the
// project's. Waiting is therefore explicit (`locator.waitFor`) and asserting is
// Vitest's, which is the same split the browser-mode tiers already use.

import { describe, expect, it } from "vitest";

import { RENDERER_ORIGIN } from "../../../src/main/renderer-scheme.js";
import {
  CONSOLE_DATABASE_NAME,
  PERSISTENCE_GLOBAL_PARTITION,
  SCHEME_PREFERENCE_KEY,
  UI_STATE_STORE_NAME,
} from "../../../src/renderer/src/console/persistence/index.js";
import { fixtureBundleExists, launchConsole } from "../electron-harness.js";

const bundleIsBuilt = fixtureBundleExists();

describe.skipIf(!bundleIsBuilt)("end-to-end — the console in its own shell", () => {
  it("serves the window from the privileged renderer scheme", async () => {
    const consoleApplication = await launchConsole();
    try {
      // The origin is the persistence partition key: a scheme registered without
      // `standard: true` has no origin at all, and an origin-less document gets
      // neither IndexedDB nor `localStorage` — so the scheme-persistence test
      // below would fail with a storage error that says nothing about the cause.
      // Asserted first, and against the main process's own constant rather than
      // against a repeated string, so a scheme or host rename breaks this at
      // compile time instead of leaving it comparing two stale literals.
      const origin = await consoleApplication.window.evaluate(() => window.location.origin);
      expect(origin).toBe(RENDERER_ORIGIN);
    } finally {
      await consoleApplication.close();
    }
  });

  it("boots the frame with its rail, a mounted surface, and a reserved one", async () => {
    const consoleApplication = await launchConsole();
    try {
      const consoleWindow = consoleApplication.window;

      // The rail exists and carries the destinations the frame declares. Read as
      // a count rather than as specific labels: which destinations exist is the
      // route table's business and it is asserted there, while "the rail rendered
      // at all" is this tier's.
      const railButtonCount = await consoleWindow.locator(".meridian-rail__button").count();
      expect(railButtonCount).toBeGreaterThan(0);

      // The sessions destination has an owner — the frame's own all-sessions
      // surface, which creates nothing on mount and builds the absorbed
      // session-bootstrap probe only when a participant presses "Start a
      // session". The claim is that the OWNER rendered and the frame's
      // reserved-slot arm did not fire: the owner's section is present and the
      // frame's composed absence wrapper is not.
      await consoleWindow.locator(".meridian-frame").waitFor({ state: "visible" });
      await consoleWindow.locator(".meridian-sessions").waitFor({ state: "visible" });
      expect(await consoleWindow.locator(".meridian-frame__absence").count()).toBe(0);

      // And the directory read has a PRODUCER, which is what this destination
      // could not have in any build before it: the only session set the renderer
      // could name was the set this window happened to have opened, and a fresh
      // window had opened none.
      //
      // A launched shell plays the first-run scenario — a fresh install with no
      // sessions on the node — so the answer here is a served-and-empty directory,
      // and the surface renders the EMPTY kind of nothing: "no sessions yet", a
      // stated fact with a next action. The claim is that kind SPECIFICALLY, which
      // is what separates it from the two absences either side of it: a refused
      // directory renders `not-checked` ("the console never asked", which is what a
      // build with no producer shows) and a read still in flight renders
      // `not-loaded`. Waited for rather than counted immediately, because the read
      // is asynchronous and a bare count would race it into the `not-loaded` arm.
      await consoleWindow
        .locator(".meridian-sessions .meridian-nothing--empty")
        .waitFor({ state: "visible" });
      expect(
        await consoleWindow.locator(".meridian-sessions .meridian-nothing--not-checked").count(),
      ).toBe(0);
      expect(
        await consoleWindow.locator(".meridian-sessions .meridian-nothing--not-loaded").count(),
      ).toBe(0);

      // Reserved, not stubbed, on a destination that genuinely has no owner. This
      // is the half of the pair that makes the other half mean something: without
      // it, "no reserved-slot absence on sessions" would also pass over a frame
      // that had stopped rendering that arm altogether. And the absence must be
      // the COMPOSED one, not a bare line, because a bare line at the top-left of
      // a real window is what a half-painted page looks like.
      await consoleWindow.evaluate(() => {
        window.location.hash = "#/settings";
      });
      await consoleWindow
        .locator(".meridian-frame__absence .meridian-nothing--empty")
        .waitFor({ state: "visible" });
    } finally {
      await consoleApplication.close();
    }
  });

  it("keeps the renderer free of Node globals", async () => {
    const consoleApplication = await launchConsole();
    try {
      // The Tier-1 smoke test asserts this against a `SIDEKICKS_SMOKE_PROBE`
      // build through a stdout probe. It is re-asserted here for a different
      // reason and against a different artifact: this is the FIXTURES bundle
      // running the console, and a console that reached for `require` would find
      // it in a build whose hardening had regressed. The two tests do not
      // duplicate each other — they cover two bundles.
      const leaks = await consoleApplication.window.evaluate(() => ({
        require: typeof (globalThis as Record<string, unknown>)["require"],
        process: typeof (globalThis as Record<string, unknown>)["process"],
        global: typeof (globalThis as Record<string, unknown>)["global"],
      }));
      expect(leaks).toStrictEqual({
        require: "undefined",
        process: "undefined",
        global: "undefined",
      });
    } finally {
      await consoleApplication.close();
    }
  });

  it("opens the palette from a real keystroke", async () => {
    const consoleApplication = await launchConsole();
    try {
      const consoleWindow = consoleApplication.window;
      // A real key event through the real window, which is the only place the
      // whole chord path runs end to end: the browser tier's synthetic events
      // never traverse Electron's own accelerator handling, and a chord the
      // application menu swallowed would still pass there.
      await consoleWindow.keyboard.press("ControlOrMeta+KeyK");
      await consoleWindow.getByRole("dialog").waitFor({ state: "visible" });

      // And it closes. Stated because a palette that opens and cannot be
      // dismissed is worse than one that never opened — the person is stuck.
      await consoleWindow.keyboard.press("Escape");
      await consoleWindow.getByRole("dialog").waitFor({ state: "hidden" });
    } finally {
      await consoleApplication.close();
    }
  });

  it("persists an explicit colour scheme across a reload", async () => {
    const consoleApplication = await launchConsole();
    try {
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
      await consoleWindow.keyboard.press("ControlOrMeta+KeyK");
      await consoleWindow.getByRole("dialog").waitFor({ state: "visible" });
      await consoleWindow.keyboard.type("Use the dark colour scheme");
      await consoleWindow.keyboard.press("Enter");
      await expect
        .poll(readScheme, { timeout: 10_000, message: "the scheme did not change" })
        .toBe("dark");

      // The applied attribute is set synchronously and the durable write is not,
      // so the reload waits for the bytes rather than for the paint. Without this
      // the test would be racing a database commit against a navigation, and the
      // shape of losing that race is a lost preference reported as a broken
      // feature.
      await expect
        .poll(readPersistedScheme, { timeout: 10_000, message: "the scheme was never written" })
        .toBe("dark");

      // The reload is the assertion. Everything above could pass against state
      // that lives only in memory; only a reload distinguishes a preference that
      // was written from one that is merely readable in the window that wrote it.
      // IndexedDB is per-origin and this launch has its own profile, so the read
      // is of this run's own write.
      await consoleWindow.reload();
      await consoleWindow.waitForSelector(".meridian-frame");
      await expect
        .poll(readScheme, { timeout: 10_000, message: "the scheme did not survive a reload" })
        .toBe("dark");
    } finally {
      await consoleApplication.close();
    }
  });
});
