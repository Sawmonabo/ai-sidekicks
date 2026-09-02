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
// temporary directory, removed on close. This is the same defect and the same fix
// the Tier-1 smoke test records; the mechanism is restated rather than imported
// because that test owns a spawn-and-parse-stdout probe, not a driven window.
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

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

import { UNOBTRUSIVE_WINDOWS_ENV } from "../../src/main/window-reveal.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..");

/** The built main entry both tiers launch. Produced by `pnpm build:fixtures`. */
export const MAIN_ENTRY_PATH: string = join(PACKAGE_ROOT, "out", "main", "index.js");

/**
 * The property a fixture build hangs the tripwire registry on.
 *
 * Re-exported from the renderer module that SETS it rather than copied. A string
 * duplicated across this boundary cannot go wrong loudly: a rename in the
 * renderer would leave the endurance tier reading `undefined` from a global that
 * no longer exists, at the far end of the longest tier in the suite, with a
 * message about a missing property rather than about a rename. Importing makes
 * that a compile error.
 *
 * These tiers compile under `tsconfig.console-electron-test.json`, which carries
 * both the Node and the DOM libs precisely so the driver can name what the
 * renderer declares; the build-time signals the console's modules read are
 * substituted for the driver process by each tier's `define` in `vitest.config.ts`.
 */
export { TRIPWIRE_FIXTURE_GLOBAL } from "../../src/renderer/src/console/core/tripwires.js";

/**
 * The property a fixture build hangs the scenario control on, and its shape.
 *
 * Re-exported from the module that declares it, for the reason above: a tier that
 * retyped the string would read `undefined` from a property that no longer exists
 * and report a missing member rather than a rename. The module is reached
 * directly rather than through `console/bridge/index.js` because that barrel pulls
 * the provider's `.tsx` in, and this program has no JSX.
 */
export {
  SCENARIO_FIXTURE_GLOBAL,
  type ScenarioFixtureHandle,
} from "../../src/renderer/src/console/bridge/scenario-selection.js";

/**
 * The property a fixture build hangs the session-store diagnostics on, and its
 * shape.
 *
 * The third of the three handles these tiers read, re-exported on the same rule
 * as the two above: the string is imported from the module that sets it, never
 * retyped, so a rename is a compile error rather than a tier reading `undefined`
 * from a property that no longer exists. Beats delivered by the scenario engine
 * and events admitted to a store's apply chokepoint are two different claims, and
 * the endurance tier asserts both.
 */
export {
  SESSION_DIAGNOSTICS_FIXTURE_GLOBAL,
  type ConsoleSessionDiagnostics,
} from "../../src/renderer/src/console/frame/session-event-binder.js";

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

/**
 * How long a window may take to appear before the launch is called failed.
 *
 * Generous, and deliberately so: this bounds a COLD Electron start on a shared
 * CI runner, which is a different quantity from anything the budgets measure. A
 * tight bound here would turn runner contention into a red tier, and the budget
 * tier — which measures what this one merely waits for — is where a slow start
 * is supposed to be caught.
 */
export const WINDOW_APPEAR_TIMEOUT_MS = 30_000;

/**
 * How long two consecutive animation frames may take to arrive before the
 * launch is declared throttled. A painting renderer delivers them within two
 * display refreshes; a hidden or occluded one under Chromium's default
 * throttling delivers none at all, so the bound only has to be clearly above
 * a refresh interval and clearly below a tier's patience.
 */
const FRAME_WITNESS_TIMEOUT_MS = 2_000;

export interface ConsoleApplication {
  readonly application: ElectronApplication;
  readonly window: Page;
  /** Close the app and remove its private profile. Safe to call twice. */
  readonly close: () => Promise<void>;
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
}

/**
 * Launch the built console and wait for its first window.
 *
 * Throws rather than returning a partial handle: a caller that received an
 * application with no window would have to re-check the same condition, and the
 * failure it is re-checking for is exactly the one worth reporting loudly.
 */
export async function launchConsole(
  options: LaunchConsoleOptions = {},
): Promise<ConsoleApplication> {
  const userDataDirectory = mkdtempSync(join(tmpdir(), "ai-sidekicks-console-"));
  // The scenario is applied LAST so a named option cannot be shadowed by an `env`
  // entry that happens to spell the same variable — one place decides, and it is
  // the typed one.
  const scenarioEnvironment =
    options.scenarioId === undefined ? {} : { [FIXTURE_SCENARIO_ENV_VAR]: options.scenarioId };
  let application: ElectronApplication;
  try {
    application = await electron.launch({
      args: [`--user-data-dir=${userDataDirectory}`, MAIN_ENTRY_PATH],
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
      timeout: WINDOW_APPEAR_TIMEOUT_MS,
    });
  } catch (error: unknown) {
    rmSync(userDataDirectory, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    // The profile is removed whether or not the close succeeds: a temporary
    // directory left behind by a crashed run is the thing that makes the NEXT
    // run's disk-space failure look like a console defect.
    try {
      await application.close();
    } finally {
      rmSync(userDataDirectory, { recursive: true, force: true });
    }
  };

  try {
    const window = await application.firstWindow({ timeout: WINDOW_APPEAR_TIMEOUT_MS });
    // The frame element, not `domcontentloaded`: the document exists before React
    // has mounted anything, so waiting on the document would let a test assert
    // against an empty body and call it a pass.
    await window.waitForSelector(".meridian-frame", { timeout: WINDOW_APPEAR_TIMEOUT_MS });
    // A measurement from a throttled renderer is a false one. The window is
    // never revealed on macOS and revealed inactive elsewhere, so Chromium would
    // by default throttle its timers and frames and report the document hidden
    // — unless the build switched background throttling off for this launch.
    // The tiers assert the state they measure in rather than trust it, twice:
    // what the document REPORTS, and whether frames actually ARRIVE, since the
    // first is a flag and the second is the thing the endurance tier times.
    const visibilityState = await window.evaluate(() => document.visibilityState);
    if (visibilityState !== "visible") {
      throw new Error(
        `the console document is "${visibilityState}" to Chromium, so its renderer is throttled and ` +
          "nothing measured in it would describe the console; the launched build must honour " +
          `${UNOBTRUSIVE_WINDOWS_ENV} by disabling background throttling (src/main/window-reveal.ts)`,
      );
    }
    const framesArrive = await witnessAnimationFrames(window);
    if (!framesArrive) {
      throw new Error(
        `no animation frame arrived within ${String(FRAME_WITNESS_TIMEOUT_MS)} ms, so the renderer ` +
          "is not painting and nothing timed in it would describe the console; an unrevealed " +
          `window paints only with background throttling off (src/main/window-reveal.ts)`,
      );
    }
    return { application, window, close };
  } catch (error: unknown) {
    await close();
    throw error;
  }
}

/**
 * Whether the built bundle these tiers need is on disk.
 *
 * Used to SKIP with a message rather than fail with a stack trace. A missing
 * bundle is a "you have not run the build" condition, not a defect in the
 * console, and reporting it as a failure trains a reader to ignore the tier.
 *
 * `statSync` rather than `existsSync` so an entry that exists but is a directory
 * or is unreadable is also treated as absent — those fail later and much less
 * legibly, inside Electron's own startup.
 */
export function fixtureBundleExists(): boolean {
  try {
    return statSync(MAIN_ENTRY_PATH).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether the renderer delivers two consecutive animation frames in bounded
 * time. Two rather than one: a single callback can be the tail of a frame the
 * compositor was already producing, while the second proves the schedule is
 * running. The timer is cleared on either outcome so a passing launch leaves
 * nothing armed.
 */
async function witnessAnimationFrames(window: Page): Promise<boolean> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timeoutHandle = setTimeout(() => {
      resolve(false);
    }, FRAME_WITNESS_TIMEOUT_MS);
  });
  const framed = window.evaluate(
    () =>
      new Promise<true>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve(true);
          });
        });
      }),
  );
  try {
    return await Promise.race([framed, timedOut]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
