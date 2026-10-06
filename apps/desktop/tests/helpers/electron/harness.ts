// The one Playwright launch of Electron, shared by the end-to-end and endurance tiers and the
// smoke tier's refused launch.
//
// Each needs a real main process and a real renderer, built the same way so the endurance tier
// measures the application the end-to-end tier proved. A launch either plays a scenario, which the
// fixture bridge serves, or plays none and runs main's supervisor against a background service of
// the test's own.
//
// Playwright's `_electron` runs under Vitest rather than `@playwright/test`: `_electron` is the
// only part these tiers need (attaching to a real Electron process and driving its window), and a
// second runner would mean a second config, reporter and CI invocation.
//
// Profile isolation is load-bearing. Electron's default profile carries a machine-wide
// `SingletonLock`: a second Electron on it (another checkout, an unrelated app, an orphan from a
// killed run) loses `requestSingleInstanceLock()` and quits before opening a window, surfacing as
// a timeout with no error. So every launch gets its own `--user-data-dir` under the system
// temporary directory (`tests/helpers/launch/profile.ts`), removed as part of the close.
//
// Headless Linux needs an X server. `_electron.launch` takes an executable path, not a shell
// command, so a per-spawn `xvfb-run` wrapper is not available; the CI job stands one Xvfb up for
// the whole run and exports `$DISPLAY`, which every launch inherits through `process.env`. A hosted
// runner has no GPU, so the software graphics switches are in `launch/args.ts`.

import process from "node:process";

import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { onTestFinished } from "vitest";

import { UNOBTRUSIVE_WINDOWS_ENV } from "#main/windows/reveal.js";
import { BoundedCleanup } from "../cleanup/bounded.js";
import { type CleanupOutcome, type ClosableApplication } from "../cleanup/contract.js";
import {
  cleanupFailure,
  closeAfterBody,
  withCleanupOutcome,
  withProfileRemoval,
} from "../cleanup/disposition.js";
import { MAIN_ENTRY_PATH } from "../fixture/bundle.js";
import { startIsolatedService } from "../isolated-service.js";
import { composeLaunchArgs } from "../launch/args.js";
import { BodyAllowance, withBoundedBody } from "../launch/body.js";
import {
  LAUNCH_BUDGET_MS,
  LaunchDeadline,
  POST_READINESS_RESERVE_MS,
  readinessFailure,
} from "../launch/deadline.js";
import { createLaunchProfile, removeLaunchProfile } from "../launch/profile.js";
import { MainProcessOutput } from "../launch/main-process-output.js";
import { awaitPaintingAppWindow } from "../launch/readiness.js";
import { LAUNCH_TRACE_TAG } from "../launch/trace.js";

/** What a settled launch produces, before the body's own allowance is minted. */
interface LaunchedApp {
  readonly application: ElectronApplication;
  /** The first window of session views, painting. */
  readonly window: Page;
  /** The hidden console document every window is drawn from. */
  readonly consolePage: Page;
  /**
   * Closes the app and removes its private profile. Safe to call twice.
   *
   * Rejects when cleanup may have left something behind: a refused termination, a close that
   * rejected outright, or a profile that would not come off disk. That fails a test whose
   * assertions passed but which leaked an Electron or its directory. A close that lost its race
   * and was SIGKILLed is logged and resolves, since the tree is gone. The second call is a no-op
   * and never throws.
   */
  readonly close: () => Promise<void>;
}

/** A launched app plus the body's remaining allowance. */
export interface AppUnderTest extends LaunchedApp {
  /**
   * What is left of the body's own allowance; hand it to a poll's `timeout`.
   *
   * A body that invents its own figure is a second copy of a bound that will drift from the
   * registered one. `bodyAllowance.remainingMs()` is what is left when asked, and overrunning it
   * fails with the harness's own sentence rather than vitest's generic kill (`launch/body.ts`).
   */
  readonly bodyAllowance: BodyAllowance;
}

/** What a tier states about the app it launches. */
export interface LaunchAppOptions {
  /**
   * Extra environment for the Electron process, merged over `process.env`.
   *
   * Nothing reaches the renderer except through the main process, the boundary the shipped
   * application enforces.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Which scripted scenario the launched app plays, passed as `--fixture`.
   *
   * Absent, the app launches normally, beside a background service of the test's own
   * (`isolated-service.ts`). A tier reads the id off the scenario module it drives,
   * so a renamed scenario is a compile error; an unknown id fails the launch because the main
   * process refuses it and exits before any window opens.
   */
  readonly scenarioId?: string;
  /**
   * How long this tier's body gets between the settled launch and its cleanup.
   *
   * Defaults to `BODY_ALLOWANCE_MS`, the shorter registered figure, so a tier that says nothing
   * fails inside a bound that names itself. The endurance tier states
   * `ENDURANCE_BODY_ALLOWANCE_MS`, and its `testTimeout` is derived from that row
   * (`tierTimeoutFor`, `vitest/tier-projects.ts`).
   */
  readonly bodyAllowanceMs?: number;
  /**
   * Whether this launch needs `performance.memory` to be a measurement.
   *
   * At Blink's default precision `usedJSHeapSize` is quantized and served from a long-interval
   * cache, useless for gated figures that are differences of two readings seconds apart. A named
   * option so a tier states what it needs and `launch/args.ts` decides how Chromium spells it.
   * Off by default: the flag makes every read walk the heap.
   */
  readonly isPreciseHeapReadingRequired?: boolean;
  /**
   * Whether the window is put on screen and brought forward, for a test that presses it with the
   * system's own pointer. Off by default: an automated launch asks for an unobtrusive window,
   * which on macOS is never shown and never takes focus.
   */
  readonly isWindowOnScreen?: boolean;
}

/**
 * Launches the built app and waits for its first window.
 *
 * Throws rather than returning a partial handle. Every wait draws its timeout from one deadline
 * minted here, so the whole call is bounded by `LAUNCH_BUDGET_MS` however slowly its phases run
 * (`tests/helpers/launch/deadline.ts`).
 */
async function launchApp(options: LaunchAppOptions): Promise<LaunchedApp> {
  // Minted before the first phase, including the profile directory, so everything waited on is
  // inside the budget. It carries the whole allowance (readiness, the paint probe, cleanup); each
  // readiness wait reserves the two later slices off it. Cleanup takes its slice as a ceiling, so
  // it is not handed this clock (`cleanup/bounded.ts`).
  const deadline = new LaunchDeadline(LAUNCH_BUDGET_MS);
  // A launch that plays no scenario runs main's supervisor, which looks for the service; it
  // finds the test's own and starts none on the person's account. A scenario launch reaches no
  // service. The wait draws on the readiness slice, since the launch cannot be ready without it.
  const serviceEnvironment =
    options.scenarioId === undefined
      ? (await startIsolatedService(deadline.remainingMs(POST_READINESS_RESERVE_MS))).environment
      : {};
  const profile = createLaunchProfile();
  let application: ElectronApplication;
  try {
    application = await electron.launch({
      args: composeLaunchArgs({
        profileDirectory: profile.directory,
        mainEntryPath: MAIN_ENTRY_PATH,
        isPreciseHeapReadingRequired: options.isPreciseHeapReadingRequired === true,
        platform: process.platform,
        ...(options.scenarioId === undefined ? {} : { fixtureScenarioId: options.scenarioId }),
      }),
      env: {
        ...process.env,
        ...serviceEnvironment,
        ...options.env,
        // An automated launch asks for an unobtrusive window: an ordinary macOS reveal activates
        // the application, steals focus and switches Space. A fixture build honors this; a
        // release build cannot (`src/main/windows/reveal.ts`). A launch whose test presses the
        // window with the system's pointer needs it on screen and forward, so it asks for none.
        [UNOBTRUSIVE_WINDOWS_ENV]: options.isWindowOnScreen === true ? "0" : "1",
      } as Record<string, string>,
      timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
    });
  } catch (error: unknown) {
    // No application was produced, so no cleanup verdict can carry the removal, and a bare
    // `remove()` throwing here would replace the launch failure with a sentence about a
    // directory.
    throw withProfileRemoval(readinessFailure(deadline, error), removeLaunchProfile(profile));
  }

  // Read from the launch on, so a failure before the window is ready carries main's own words.
  const mainOutput = new MainProcessOutput(application.process(), profile.directory);
  const cleanup = new BoundedCleanup(
    {
      close: () => application.close(),
      // Guarded because Playwright throws once the application handle is gone, and asking who to
      // kill must not stop the profile being removed.
      processId: () => {
        try {
          return application.process().pid;
        } catch {
          return undefined;
        }
      },
    },
    profile,
  );
  let closed = false;
  let cleanupOutcome: CleanupOutcome | undefined;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // Bounded and force-terminating, and it removes the profile, so this always returns a
    // verdict, and the removal reaches the caller on it.
    cleanupOutcome = await cleanup.close();
    // Logged on every settlement but a clean close, a wider set than the one that throws: a
    // SIGKILLed tree is worth a log line, not a red check.
    if (cleanupOutcome.settlement !== "closed") {
      console.error(
        `${LAUNCH_TRACE_TAG} close settled ${cleanupOutcome.settlement} after ` +
          `${String(cleanupOutcome.waitedMs)} ms of the ` +
          `${String(cleanupOutcome.budgetMs)} ms it was given`,
      );
    }
    const failure = cleanupFailure(cleanupOutcome);
    if (failure === undefined) {
      return;
    }
    // Thrown, not only logged: a `console.error` is not a failure to vitest. The launch-failure
    // path swallows this rejection to keep the original error on top.
    throw failure;
  };

  try {
    const { window, consolePage } = await awaitPaintingAppWindow(application, deadline);
    return { application, window, consolePage, close };
  } catch (error: unknown) {
    // Read before the close, which ends main and removes its profile.
    const standing = mainOutput.standing();
    // `close()` rejects on abnormal cleanup, but the launch already failed and its error explains
    // the run. So the rejection is swallowed and the cleanup outcome is attached to the original.
    try {
      await close();
    } catch {
      // Recorded in `cleanupOutcome`, and attached by the throw below.
    }
    throw withCleanupOutcome(mainOutput.failureWith(error, standing), cleanupOutcome);
  }
}

/**
 * Binds `application`'s close to the end of the current test, and closes now when that
 * registration refuses.
 *
 * `onTestFinished` runs the close on whatever outcome the test reaches, vitest's timeout kill
 * included. It throws outside a running test (for example `withLaunchedApp` from a `beforeAll`)
 * when Electron is already up with a private profile on disk; the refusal is caught and the same
 * idempotent close is awaited immediately, so exactly one remover is reached from both paths. If
 * that close fails too, `closeAfterBody`'s rule applies: the refusal explains the run and the
 * cleanup verdict rides on it as a clause.
 *
 * The registered close fails the test instead of being swallowed. On a vitest timeout it is the
 * only close there is, and the `closed` guard means no caller can ask again; its bounded retries
 * are spent by the time it raises, so the failure means an Electron nothing could kill is still
 * running and holding its profile for every later launch.
 */
async function registerSettleTimeClose(
  application: Pick<ClosableApplication, "close">,
): Promise<void> {
  try {
    onTestFinished(async () => {
      await application.close();
    });
  } catch (registrationRefusal: unknown) {
    await closeAfterBody(application, (): Promise<never> => {
      throw registrationRefusal;
    });
  }
}

/**
 * Launches the app, runs `body` against it, and closes it afterwards.
 *
 * The one way in (`launchApp` is not exported), so no tier can reach the launched application
 * without `closeAfterBody`'s rule that the body's failure survives a failing close.
 */
export async function withLaunchedApp<TResult>(
  options: LaunchAppOptions,
  body: (appUnderTest: AppUnderTest) => Promise<TResult>,
): Promise<TResult> {
  const launched = await launchApp(options);
  // The body's own settlement closes this launch and reports the cleanup verdict. Vitest's
  // per-test timeout skips it, so this settle-time registration covers that path. `close` is
  // idempotent, so on an ordinary outcome the registered close is a no-op.
  //
  // Awaited because the registration can refuse; `registerSettleTimeClose` owns both halves.
  await registerSettleTimeClose(launched);
  // Minted here, not inside the launch: the allowance bounds what runs after the launch settled,
  // so a slow but valid launch spends none of it.
  const bodyAllowance = new BodyAllowance(options.bodyAllowanceMs);
  const appUnderTest: AppUnderTest = { ...launched, bodyAllowance };
  return await withBoundedBody(launched, bodyAllowance, async () => await body(appUnderTest));
}
