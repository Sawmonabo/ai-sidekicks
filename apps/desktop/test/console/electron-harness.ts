// The one Electron launcher, shared by the end-to-end and endurance tiers.
//
// Both tiers need the same thing — a real shell, a real renderer, the fixture
// bridge serving the console — and they need it built the same way, or the
// endurance tier would be measuring a different application from the one the
// end-to-end tier proved. So the launch lives here and neither tier owns a copy.
//
// WHY PLAYWRIGHT'S `_electron` UNDER VITEST, AND NOT `@playwright/test`
//
// `@playwright/test` is already a devDependency and it exports `_electron`, which
// is the only part of it these tiers need: a way to attach to a real Electron
// process and drive its window. The RUNNER is a separate question, and the answer
// is Vitest — the console already registers seven tiers there with disjoint globs,
// and a second runner would mean a second config, a second reporter, a second set
// of CI invocations, and two places to look when a tier is red. One runner, two
// more projects.
//
// PROFILE ISOLATION IS LOAD-BEARING, NOT HYGIENE
//
// Electron's default profile carries a machine-wide `SingletonLock`. A second
// Electron on the default profile — another checkout running this suite, an
// unrelated app, an orphan from a killed run — loses `requestSingleInstanceLock()`
// and quits before opening a window, which would surface here as a timeout with no
// error. Every launch therefore gets its own `--user-data-dir` under the system
// temporary directory (`launch-profile.ts`), removed as part of the close. This is
// the same defect and the same fix the Tier-1 smoke test records; the mechanism is
// restated rather than imported because that test owns a spawn-and-parse-stdout
// probe, not a driven window.
//
// HEADLESS LINUX
//
// A CI runner without a display server needs an X server. `_electron.launch`
// takes an executable path rather than a shell command, so a per-spawn
// `xvfb-run` wrapper is not available the way it is for the smoke test's
// `spawn` — and it is not wanted either: the tier-1 job stands one Xvfb up for
// the whole run and exports `$DISPLAY` to every later step, which both tiers
// inherit through `process.env`. They run in the aggregate `test` script's last
// group and in that job's desktop step, both on the fixture build.
//
// That display is not a GL driver, and a hosted runner has no GPU behind it, so
// the software graphics stack such a host needs is stated in the launch's own
// arguments — see `launch-args.ts`, which owns every switch this launcher passes
// and why each one is passed.

import process from "node:process";

import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

import { UNOBTRUSIVE_WINDOWS_ENV } from "../../src/main/window-reveal.js";
import { disposeWhenTestFinishes } from "../helpers/electron-child.js";
import {
  BoundedCleanup,
  type CleanupOutcome,
  ELECTRON_PROCESS_TERMINATOR,
} from "./bounded-cleanup.js";
import { cleanupFailure, withCleanupOutcome, withProfileRemoval } from "./cleanup-disposition.js";
import { MAIN_ENTRY_PATH } from "./fixture-bundle.js";
import { composeLaunchArgs } from "./launch-args.js";
import { BodyAllowance, withBoundedBody } from "./launch-body.js";
import {
  LAUNCH_BUDGET_MS,
  LaunchDeadline,
  POST_READINESS_RESERVE_MS,
  readinessFailure,
} from "./launch-deadline.js";
import { createLaunchProfile, removeLaunchProfile } from "./launch-profile.js";
import { awaitPaintingConsoleWindow } from "./launch-readiness.js";
import { LAUNCH_TRACE_TAG } from "./launch-trace.js";

/**
 * The environment variable the built main process reads a scenario id from.
 *
 * Held here rather than imported: `src/main/index.ts` boots Electron at module
 * evaluation, so importing it into a driver process is not available. The two
 * literals are pinned end-to-end instead — `steady-state.test.ts` launches with a
 * scenario id and asserts the console is playing that scenario, so a drift on
 * either side fails that tier rather than quietly selecting nothing.
 */
const FIXTURE_SCENARIO_ENV_VAR = "SIDEKICKS_FIXTURE_SCENARIO";

/** What a settled launch produces, before the body's own allowance is minted. */
interface LaunchedConsole {
  readonly application: ElectronApplication;
  readonly window: Page;
  /**
   * Close the app and remove its private profile. Safe to call twice.
   *
   * REJECTS when cleanup may have left something behind — a termination that was
   * refused, a close that rejected outright, or a profile that would not come off
   * disk. A caller that awaits this therefore fails a test whose assertions passed
   * but which leaked an Electron or its directory, which is the point: vitest does
   * not read logs, and either would otherwise survive into the launches after it.
   * A close that lost its race and was SIGKILLed is breadcrumbed and resolves: the
   * tree is gone, so the launches after it are unaffected. The second call is a
   * no-op and never throws.
   */
  readonly close: () => Promise<void>;
}

export interface ConsoleApplication extends LaunchedConsole {
  /**
   * What is LEFT of the body's own allowance — hand it to a poll's `timeout`.
   *
   * A body that waits has to bound its wait, and a body that invents a figure for
   * that is a second copy of a bound which will drift from the registered one. So
   * the wrapper mints the allowance once the launch has settled and passes it
   * down: `consoleApplication.bodyAllowance.remainingMs()` is always what is left
   * at the moment it is asked, and overrunning it fails with the harness's own
   * sentence rather than vitest's generic kill (`launch-body.ts`).
   */
  readonly bodyAllowance: BodyAllowance;
}

export interface LaunchConsoleOptions {
  /**
   * Extra environment for the Electron process.
   *
   * Merged over `process.env`. A tier uses this to pin a clock or a probe;
   * nothing here reaches the renderer except through the main process, which is
   * the same boundary the shipped application enforces.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Which scripted scenario the launched console plays.
   *
   * A named option rather than an `env` entry a caller spells itself, so the one
   * thing every tier needs to say is said the same way and the variable name lives
   * in one place. Pass a manifest id — a tier reads it off the scenario module it
   * is driving, so a renamed scenario is a compile error rather than a launch that
   * quietly falls back. An unknown id does NOT fail the launch: the console plays
   * its first-run scenario and says why, which is what makes the assertion that it
   * is playing the RIGHT one worth making.
   */
  readonly scenarioId?: string;
  /**
   * How long this tier's body gets between the settled launch and its cleanup.
   *
   * Defaults to `BODY_ALLOWANCE_MS`, the shorter of the two registered figures,
   * so a tier that says nothing fails inside a bound that names itself rather
   * than under vitest's generic kill. A tier whose body is a different subject —
   * the endurance workload, hundreds of driven cycles rather than one interaction
   * — states `ENDURANCE_BODY_ALLOWANCE_MS`, and its `testTimeout` is derived from
   * that same row (`tierTimeoutFor`, `vitest.config.ts`).
   */
  readonly bodyAllowanceMs?: number;
  /**
   * Whether this launch needs `performance.memory` to be a MEASUREMENT.
   *
   * At Blink's default precision `usedJSHeapSize` is quantized into buckets and
   * served from a long-interval cache rather than read at the moment it is asked
   * for, which is fine for a coarse sanity check and useless for a tier whose
   * gated figures are differences of two readings taken seconds apart. A named
   * option rather than a caller-spelled argument list, so a tier states what it
   * NEEDS and `launch-args.ts` decides how Chromium spells it.
   *
   * Off by default: the flag makes every read walk the heap, which is a cost no
   * tier that does not measure one should pay.
   */
  readonly isPreciseHeapReadingRequired?: boolean;
}

/**
 * Launch the built console and wait for its first window.
 *
 * Throws rather than returning a partial handle: a caller that received an
 * application with no window would have to re-check the same condition, and the
 * failure it is re-checking for is exactly the one worth reporting loudly.
 *
 * Every wait below draws its timeout from ONE deadline minted here, so the whole
 * call is bounded by `LAUNCH_BUDGET_MS` however slowly its phases run — see
 * `launch-deadline.ts` for why a timeout per phase could not be.
 */
async function launchConsole(options: LaunchConsoleOptions): Promise<LaunchedConsole> {
  // Minted before the first phase, including the profile directory: everything
  // this function waits on is inside the budget, or the budget is not the
  // launch's. It carries the WHOLE allowance — readiness, the witness, and
  // cleanup — and each readiness wait below reserves the two later slices off
  // it, so a slow ladder cannot spend the intervals that diagnose it. Cleanup
  // takes its own slice as a ceiling rather than drawing on what is left here,
  // which is why it is not handed this clock (`bounded-cleanup.ts`).
  const deadline = new LaunchDeadline(LAUNCH_BUDGET_MS);
  const profile = createLaunchProfile();
  // The scenario is applied LAST so a named option cannot be shadowed by an `env`
  // entry that happens to spell the same variable — one place decides, and it is
  // the typed one.
  const scenarioEnvironment =
    options.scenarioId === undefined ? {} : { [FIXTURE_SCENARIO_ENV_VAR]: options.scenarioId };
  let application: ElectronApplication;
  try {
    application = await electron.launch({
      args: composeLaunchArgs({
        profileDirectory: profile.directory,
        mainEntryPath: MAIN_ENTRY_PATH,
        isPreciseHeapReadingRequired: options.isPreciseHeapReadingRequired === true,
        platform: process.platform,
      }),
      env: {
        ...process.env,
        ...options.env,
        ...scenarioEnvironment,
        // Every automated launch asks for an unobtrusive window: on macOS an
        // ordinary reveal activates the application, steals focus, and switches
        // the operator to the Space the window opened on — a dozen times per
        // aggregate run. A fixture build honours this; a release build cannot
        // (see `src/main/window-reveal.ts`).
        [UNOBTRUSIVE_WINDOWS_ENV]: "1",
      } as Record<string, string>,
      timeout: deadline.remainingMs(POST_READINESS_RESERVE_MS),
    });
  } catch (error: unknown) {
    // No application was produced, so there is no cleanup verdict for the removal
    // to travel on — and a bare `remove()` throwing here would replace the launch
    // failure with a sentence about a directory. Surfaced and folded instead, so
    // the readiness failure stays the error that explains the run.
    throw withProfileRemoval(readinessFailure(deadline, error), removeLaunchProfile(profile));
  }

  const cleanup = new BoundedCleanup(
    {
      close: () => application.close(),
      // Guarded because Playwright throws rather than returning `undefined` once
      // the application handle is gone, and cleanup asking who to kill must not
      // itself become the failure that stops the profile being removed.
      processId: () => {
        try {
          return application.process().pid;
        } catch {
          return undefined;
        }
      },
    },
    ELECTRON_PROCESS_TERMINATOR,
    profile,
  );
  let closed = false;
  let cleanupOutcome: CleanupOutcome | undefined;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // The close itself is bounded and force-terminating, and it removes the
    // profile, so this always returns a verdict rather than possibly not
    // returning at all — and the removal reaches the caller ON that verdict. It
    // used to be an `rmSync` in its own `try`/`catch` here whose `catch` only
    // printed, so a removal that failed left a passing tier green and the
    // directory on disk for every launch after it.
    cleanupOutcome = await cleanup.close();
    // Breadcrumbed on every settlement but a clean close, and that is wider than
    // the set that throws: a SIGKILLed tree is worth a line in the log and is not
    // worth a red check, so `terminated` is recorded here and passes below.
    if (cleanupOutcome.settlement !== "closed") {
      console.error(
        `${LAUNCH_TRACE_TAG} close settled ${cleanupOutcome.settlement} after ` +
          `${String(cleanupOutcome.waitedMs)} ms of the ${String(cleanupOutcome.budgetMs)} ms it was given`,
      );
    }
    const failure = cleanupFailure(cleanupOutcome);
    if (failure === undefined) {
      return;
    }
    // Thrown, not only logged: a `console.error` is not a failure to vitest, so a
    // tier whose assertions passed would otherwise report success while leaving
    // an Electron alive for every launch after it. The launch-failure path
    // swallows this rejection to keep the original error on top.
    throw failure;
  };

  try {
    const window = await awaitPaintingConsoleWindow(application, deadline);
    return { application, window, close };
  } catch (error: unknown) {
    // `close()` rejects on abnormal cleanup, and here that rejection must NOT
    // win: the launch already failed and its error is the one that explains the
    // run. So it is swallowed and the cleanup outcome is attached to the original
    // instead — one error carrying both, never two with the wrong one on top.
    try {
      await close();
    } catch {
      // Recorded in `cleanupOutcome`, and attached by the throw below.
    }
    throw withCleanupOutcome(error, cleanupOutcome);
  }
}

/**
 * Launch the console, run `body` against it, and close it afterwards.
 *
 * The one way in, so `launchConsole` is not exported: a tier that held the
 * handle itself would have to spell the disposition out, and nine of them did —
 * as a bare `finally`, which destroys the body's failure whenever the close
 * fails too. `closeAfterBody` states that rule once and is tested without an
 * Electron; this adds the launch, so no tier can reach the launched application
 * without also getting the rule.
 */
export async function withLaunchedConsole<TResult>(
  options: LaunchConsoleOptions,
  body: (consoleApplication: ConsoleApplication) => Promise<TResult>,
): Promise<TResult> {
  const launched = await launchConsole(options);
  // The body's own settlement closes this launch, and that is the path that
  // reports a cleanup verdict. This is the OTHER path: vitest's per-test timeout
  // does not run the body's settlement at all, so without a settle-time
  // registration a tier that overran its own budget left a real Electron and a
  // real profile directory behind. `close` is idempotent, so on every ordinary
  // outcome this is a no-op — the shared door swallows the rejection, because by
  // then the test's own failure is the one that explains the run.
  disposeWhenTestFinishes(async () => {
    await launched.close();
  });
  // Minted HERE and not inside the launch: the allowance bounds what runs after
  // the launch settled, so a slow-but-valid launch spends none of it. That is the
  // whole arithmetic the tier timeout is derived from — launch, then body, then
  // the cleanup the launch budget already reserves.
  const bodyAllowance = new BodyAllowance(options.bodyAllowanceMs);
  const consoleApplication: ConsoleApplication = { ...launched, bodyAllowance };
  return await withBoundedBody(launched, bodyAllowance, async () => await body(consoleApplication));
}
