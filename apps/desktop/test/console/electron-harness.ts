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
// A CI runner without a display server needs `xvfb-run`. `_electron.launch` takes
// an executable path rather than a shell command, so wrapping is not available the
// way it is for the smoke test's `spawn`. The tiers are therefore not wired into
// the default `test` task, and CI runs them under a job that provides a display —
// the same posture the three browser-mode tiers already take.

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";

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
 * How long a window may take to appear before the launch is called failed.
 *
 * Generous, and deliberately so: this bounds a COLD Electron start on a shared
 * CI runner, which is a different quantity from anything the budgets measure. A
 * tight bound here would turn runner contention into a red tier, and the budget
 * tier — which measures what this one merely waits for — is where a slow start
 * is supposed to be caught.
 */
export const WINDOW_APPEAR_TIMEOUT_MS = 30_000;

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
   * Merged over `process.env`. A tier uses this to pin a scenario or a clock;
   * nothing here reaches the renderer except through the main process, which is
   * the same boundary the shipped application enforces.
   */
  readonly env?: Readonly<Record<string, string>>;
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
  let application: ElectronApplication;
  try {
    application = await electron.launch({
      args: [`--user-data-dir=${userDataDirectory}`, MAIN_ENTRY_PATH],
      env: { ...process.env, ...options.env } as Record<string, string>,
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
