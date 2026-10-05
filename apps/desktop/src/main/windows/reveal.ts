// Unobtrusive windows for the automated tiers, in test builds only. On macOS `show()` activates
// the app: the Dock icon appears, focus moves, and a person on a full-screen Space is switched
// away. So when a test tier sets one environment variable, a test build:
//
//   1. sets the macOS activation policy to `accessory`: no Dock icon, never activated for a window;
//   2. never reveals the window on macOS, where `show()` would activate even an accessory app, and
//      reveals it with `showInactive()` elsewhere;
//   3. switches background throttling off, so a hidden or occluded window keeps drawing frames and
//      a measurement describes an unthrottled renderer.
//
// The split in (2) is measured: with throttling off, Electron keeps frames running for a hidden
// window on macOS but not on Windows (electron/electron#31016). Linux runs under Xvfb and takes
// the inactive reveal. `tests/helpers/launch/readiness.ts` checks on every launch that the
// document stays visible and draws. A release bundle carries none of this: all three sit behind
// the compile-time build flag.

import type { App, BaseWindow, WebContents } from "electron";

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
 * Decides how a window is revealed from the build kind, the environment and the platform. Only
 * the exact string `"1"` opts in. A requested test build stays hidden on macOS and reveals
 * inactive elsewhere.
 */
function resolveWindowRevealMode(
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
function resolveActivationPolicyChange(
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

/** The kept state a window is revealed into, beyond its rectangle. */
export interface RevealState {
  readonly isMaximized: boolean;
  readonly isFullScreen: boolean;
}

/**
 * Puts a window on screen the way this launch asked for, maximized or fullscreen when its kept
 * place was. Called by `./window.ts`, the one reveal site, as it builds a window a person sees.
 * Maximizing shows a window, so the kept state is applied only where the window is shown.
 */
export function revealWindow(
  baseWindow: Pick<BaseWindow, "show" | "showInactive" | "maximize" | "setFullScreen">,
  state: RevealState,
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
      baseWindow.showInactive();
      return;
    }
  }
  baseWindow.show();
  if (state.isFullScreen) {
    baseWindow.setFullScreen(true);
  } else if (state.isMaximized) {
    baseWindow.maximize();
  }
}

/**
 * Brings an open window to the front and gives it focus, restoring it from the Dock or taskbar:
 * a second launch, or a request for a view that window already shows.
 */
export function bringWindowForward(
  baseWindow: Pick<BaseWindow, "isMinimized" | "restore" | "show" | "showInactive" | "focus">,
  platform: NodeJS.Platform = process.platform,
): void {
  if (__TEST_TIER_BUILD__) {
    const mode = resolveWindowRevealMode(true, process.env, platform);
    if (mode === "hidden") {
      return;
    }
    if (mode === "inactive") {
      baseWindow.showInactive();
      return;
    }
  }
  if (baseWindow.isMinimized()) {
    baseWindow.restore();
  }
  baseWindow.show();
  baseWindow.focus();
}

/**
 * Keeps a window's renderer un-throttled when it will stay hidden or be revealed inactive.
 * Called from `./window.ts` right after construction, before the load. The release arm touches
 * nothing, so an ordinary window keeps Chromium's default throttling.
 */
export function applyRevealPreferences(
  webContents: Pick<WebContents, "setBackgroundThrottling">,
  platform: NodeJS.Platform = process.platform,
): void {
  if (__TEST_TIER_BUILD__ && resolveWindowRevealMode(true, process.env, platform) !== "active") {
    webContents.setBackgroundThrottling(false);
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
