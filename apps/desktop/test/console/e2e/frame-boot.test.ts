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
//
// EVERY WAIT IS CHARGED TO THE BODY'S ALLOWANCE
//
// `withLaunchedConsole` reserves an allowance for what runs between a settled
// launch and its cleanup, and a wait that ignored it would be bounded twice over
// with the wrong one winning: a poll declaring 10 000 ms against an allowance
// with 200 ms left runs past the allowance, and the outer race then replaces the
// poll's own message ("the scheme did not change") with the generic body-overrun
// sentence. So every bounded wait below is handed
// `bodyAllowance.boundedMs(<its own bound>)` — the smaller of the two — which is
// what makes the FIRST wait that cannot fit fail saying which step it was.
// `architecture/body-allowance-consumption.test.ts` reads this file and fails on
// a wait that names no allowance.

import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import { RENDERER_ORIGIN } from "../../../src/main/renderer-scheme.js";
import {
  PERSISTENCE_GLOBAL_PARTITION,
  SCHEME_PREFERENCE_KEY,
} from "../../../src/renderer/src/console/persistence/index.js";
import {
  CONSOLE_DATABASE_NAME,
  UI_STATE_STORE_NAME,
} from "../../../src/renderer/src/console/persistence/indexeddb-adapter.js";
import { FIRST_RUN_SCENARIO } from "../../../src/renderer/src/console/bridge/scenarios/first-run.js";
import { withLaunchedConsole } from "../electron-harness.js";
import { closePalette, openPalette } from "../palette-interaction.js";
import { fixtureBundleExists } from "../fixture-bundle.js";
import { IN_WINDOW_STEP_TIMEOUT_MS } from "../launch-body.js";
import { READINESS_BUDGET_MS } from "../launch-budgets.js";
import { LaunchDeadline } from "../launch-deadline.js";

const bundleIsBuilt = fixtureBundleExists();

/**
 * How long a starved animation frame is held, in milliseconds.
 *
 * Long enough that a frame cannot land inside the round trip between two
 * Playwright calls, which is what makes the control deterministic rather than a
 * coin flip on a fast host; short enough that the reopen it precedes still
 * settles well inside the in-window step bound.
 */
const STARVED_FRAME_DELAY_MS = 1_500;

/**
 * Hold every animation frame back, so a step that silently depends on one shows it.
 *
 * A test instrument and not a stub of the subject: the callbacks still run, on the
 * real frame the window schedules, only later. It perturbs the ENVIRONMENT the way
 * a loaded runner does, which is the condition the defect it controls for needs and
 * the one no local machine reproduces. Irreversible for the window it is applied
 * to, so it is the last thing a body does.
 */
async function delayEveryAnimationFrame(consoleWindow: Page): Promise<void> {
  await consoleWindow.evaluate((delayMs) => {
    const scheduleFrame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = ((callback: FrameRequestCallback): number => {
      window.setTimeout(() => {
        scheduleFrame(callback);
      }, delayMs);
      // The handle a caller would cancel with. Nothing in the console cancels a
      // frame it requested, and returning a real id would name a frame that has
      // not been requested yet — so this reports the one honest answer instead.
      return 0;
    }) as typeof window.requestAnimationFrame;
  }, STARVED_FRAME_DELAY_MS);
}

describe.skipIf(!bundleIsBuilt)("end-to-end — the console in its own shell", () => {
  it("serves the window from the privileged renderer scheme", async () => {
    await withLaunchedConsole({}, async (consoleApplication) => {
      // The origin is the persistence partition key: a scheme registered without
      // `standard: true` has no origin at all, and an origin-less document gets
      // neither IndexedDB nor `localStorage` — so the scheme-persistence test
      // below would fail with a storage error that says nothing about the cause.
      // Asserted first, and against the main process's own constant rather than
      // against a repeated string, so a scheme or host rename breaks this at
      // compile time instead of leaving it comparing two stale literals.
      const origin = await consoleApplication.window.evaluate(() => window.location.origin);
      expect(origin).toBe(RENDERER_ORIGIN);
    });
  });

  it("boots the frame with its rail, a mounted surface, and a reserved one", async () => {
    await withLaunchedConsole({}, async (consoleApplication) => {
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
      await consoleWindow.locator(".meridian-frame").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      await consoleWindow.locator(".meridian-sessions").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      expect(await consoleWindow.locator(".meridian-surface-absence").count()).toBe(0);

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
      //
      // Scoped to the list region rather than to the whole surface: the aside
      // beside it puts two OTHER reads on screen — the invitations shelf and the
      // attention panel — and each renders its own honest absence, so an unscoped
      // exclusion would be asserting that those reads had answered rather than
      // that this one had.
      await consoleWindow.locator(".meridian-sessions__list .meridian-nothing--empty").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
      expect(
        await consoleWindow
          .locator(".meridian-sessions__list .meridian-nothing--not-checked")
          .count(),
      ).toBe(0);
      expect(
        await consoleWindow
          .locator(".meridian-sessions__list .meridian-nothing--not-loaded")
          .count(),
      ).toBe(0);

      // Reserved, not stubbed, on a destination that genuinely has no owner. This
      // is the half of the pair that makes the other half mean something: without
      // it, "no reserved-slot absence on sessions" would also pass over a frame
      // that had stopped rendering that arm altogether. And the absence must be
      // the COMPOSED one, not a bare line, because a bare line at the top-left of
      // a real window is what a half-painted page looks like.
      //
      // Re-pointed rather than deleted, which is the instruction the previous probe
      // left behind: it moved off `#/settings` when the collaboration family took
      // that destination, and the workflows family has now taken `#/workflows`. Of
      // the seven declared surface slots exactly one is still unclaimed — `timeline`
      // — so it is the only address left that can ask this question at all.
      //
      // It is an AUXILIARY address, and that costs a session id: a bare
      // `#/window/timeline` names a window without naming what to show in it, and
      // the frame answers with the context picker rather than with an absence. So
      // the probe names the scenario's own session, which this shell is playing —
      // the first-run DIRECTORY is empty, which is what the assertion above is
      // about, while the session it holds is readable, which is what gets the store
      // open and the route as far as the slot. Re-point it again — do not delete it
      // — the day a family claims `timeline`, and if that leaves no unclaimed slot
      // at all, this probe has to be told which one to reserve rather than guess.
      await consoleWindow.evaluate((sessionId: string) => {
        window.location.hash = `#/window/timeline/${sessionId}`;
      }, FIRST_RUN_SCENARIO.sessionId);
      await consoleWindow.locator(".meridian-surface-absence .meridian-nothing--empty").waitFor({
        state: "visible",
        timeout: consoleApplication.bodyAllowance.boundedMs(IN_WINDOW_STEP_TIMEOUT_MS),
      });
    });
  });

  it("keeps the renderer free of Node globals", async () => {
    await withLaunchedConsole({}, async (consoleApplication) => {
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
    });
  });

  it("opens the palette from a real keystroke and focuses it before a frame lands", async () => {
    await withLaunchedConsole({}, async (consoleApplication) => {
      // A real key event through the real window, which is the only place the
      // whole chord path runs end to end: the browser tier's synthetic events
      // never traverse Electron's own accelerator handling, and a chord the
      // application menu swallowed would still pass there. `openPalette` also
      // waits for the input to hold focus, which is the fact the test below
      // depends on and the one this tier is the only place to observe.
      const paletteInput = await openPalette(consoleApplication);

      // And it closes. Stated because a palette that opens and cannot be
      // dismissed is worse than one that never opened — the person is stuck.
      await closePalette(consoleApplication);

      // THE NEGATIVE CONTROL for that focus wait, and it costs no second launch.
      // Base UI queues the palette's initial focus on an animation frame
      // (`palette-interaction.ts` names the chain), so a runner that is not
      // producing frames leaves the input focusABLE and unfocused for as long as
      // that takes — invisible on a developer's machine, where the frame lands
      // between two Playwright round trips. Delaying every frame widens that
      // window until it is observable: with the wait, focus is there when
      // `openPalette` returns; with the wait deleted, this line reads `false`,
      // which is the defect that failed the tier on CI.
      await delayEveryAnimationFrame(consoleApplication.window);
      await openPalette(consoleApplication);
      expect(await paletteInput.evaluate((element) => element === document.activeElement)).toBe(
        true,
      );
    });
  });

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
