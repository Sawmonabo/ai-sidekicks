// Unobtrusive windows for the automated tiers, in test builds only.
//
// Every Electron tier (smoke probe, GC probe, end-to-end, endurance) launches the real main
// process with a real window. On macOS `BrowserWindow.show()` activates the application: the
// Dock icon appears, focus moves, and the person on a full-screen Space is switched away. The
// tiers therefore ask for unobtrusive windows through one environment variable, and a test
// build honors it in three places:
//
//   1. the activation policy: macOS `accessory`, so the app has no Dock icon and is never
//      activated on a window's behalf;
//   2. the reveal: on macOS the window is never revealed and stays hidden as constructed (an
//      accessory app can still be activated programmatically, and `show()` is such an
//      activation); elsewhere it is revealed with `showInactive()`, which orders the window in
//      front without making it key;
//   3. background throttling is switched off: Chromium throttles timers and animation frames for
//      a hidden or occluded window, and a measurement there describes a throttled renderer. With
//      throttling off the document stays `visible` and frames are still drawn.
//      `tests/helpers/launch-readiness.ts` asserts both on every launch.
//
// The platform split in (2) is measured: Electron's `disable_hidden` patch, which throttling-off
// switches on, keeps animation frames running for an occluded, minimized and hidden window on
// macOS, but on Windows only for the first two; a hidden window there stops painting
// (electron/electron#31016). Linux runs under Xvfb, where there is no person to disturb, and
// takes the inactive reveal.
//
// All three sit behind the compile-time build flag, so a release bundle carries neither the
// environment read nor the branch. Within a test build the variable is still an opt-in.

import type { App, BrowserWindow, WebContents } from "electron";

// Substituted by the `define` block in `electron.vite.config.ts` and by the Vitest project
// (`vitest.config.ts`): `true` in the smoke and fixtures builds the automated tiers launch,
// `false` otherwise. Not the fixture flag, which the development build also turns on; a
// developer's window is never hidden.
declare const __TEST_TIER_BUILD__: boolean;

/**
 * The environment variable the automated tiers set to `"1"`. The harnesses that spawn Electron
 * import it, so a rename is a compile error rather than a tier that steals focus again.
 */
export const UNOBTRUSIVE_WINDOWS_ENV = "SIDEKICKS_UNOBTRUSIVE_WINDOWS";

/**
 * How a ready window is put on screen. `hidden` leaves it as constructed (`show: false`), so
 * nothing is ever ordered onto a screen.
 */
type WindowRevealMode = "active" | "inactive" | "hidden";

/** The one activation policy this module ever sets; `null` means leave Electron's default. */
type ActivationPolicyChange = "accessory" | null;

/**
 * Decides how a window is revealed from the build kind, the environment and the platform. Pure:
 * the build flag is an argument so a unit project whose flag is `false` can reach the test-build
 * arm. Only the exact string `"1"` opts in. A requested test build stays hidden on macOS and
 * reveals inactive elsewhere.
 */
export function resolveWindowRevealMode(
  testBuild: boolean,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): WindowRevealMode {
  if (!(testBuild && environment[UNOBTRUSIVE_WINDOWS_ENV] === "1")) {
    return "active";
  }
  return platform === "darwin" ? "hidden" : "inactive";
}

/**
 * Decides whether the activation policy changes. Only macOS has one (`setActivationPolicy`
 * exists nowhere else), so every other platform answers `null`.
 */
export function resolveActivationPolicyChange(
  testBuild: boolean,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ActivationPolicyChange {
  if (platform !== "darwin") {
    return null;
  }
  return resolveWindowRevealMode(testBuild, environment, platform) === "active"
    ? null
    : "accessory";
}

/**
 * Puts a ready window on screen the way this launch asked for. Called from the `ready-to-show`
 * handler in `./window.ts`, the one reveal site.
 */
export function revealWindow(
  browserWindow: Pick<BrowserWindow, "show" | "showInactive">,
  platform: NodeJS.Platform = process.platform,
): void {
  // The flag is tested inline as a literal in each wrapper: Vite substitutes it textually, so
  // a release bundle reads `if (false)` and Rollup drops the branch and the variable name.
  // Behind a helper the environment read would survive into the release binary.
  if (__TEST_TIER_BUILD__) {
    const mode = resolveWindowRevealMode(true, process.env, platform);
    if (mode === "hidden") {
      // Left as constructed; with throttling off it paints at full rate once loaded.
      return;
    }
    if (mode === "inactive") {
      browserWindow.showInactive();
      return;
    }
  }
  browserWindow.show();
}

/**
 * Keeps a window's renderer un-throttled when it will stay hidden or be revealed inactive.
 * Called from `./window.ts` right after construction, before the load. The release arm touches
 * nothing, so an ordinary window keeps Chromium's default throttling.
 */
export function applyRevealPreferences(
  browserWindow: { readonly webContents: Pick<WebContents, "setBackgroundThrottling"> },
  platform: NodeJS.Platform = process.platform,
): void {
  if (__TEST_TIER_BUILD__ && resolveWindowRevealMode(true, process.env, platform) !== "active") {
    browserWindow.webContents.setBackgroundThrottling(false);
  }
}

/**
 * Applies the activation policy this launch asked for. Call inside `app.whenReady()` before the
 * first window: the policy must precede any reveal, and `NSApplication` exists only once the
 * app is ready.
 */
export function installActivationPolicy(
  app: Pick<App, "setActivationPolicy">,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!__TEST_TIER_BUILD__) {
    return;
  }
  const change = resolveActivationPolicyChange(true, process.env, platform);
  if (change !== null) {
    app.setActivationPolicy(change);
  }
}
