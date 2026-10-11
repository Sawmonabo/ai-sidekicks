// Unobtrusive windows for the automated tiers, in test builds only. An ordinary reveal activates
// the app: on macOS the Dock icon appears, focus moves, and a person on a full-screen Space is
// switched away. So when a test tier sets one environment variable, a test build:
//
//   1. sets the activation policy the operating system has for an app that never activates, where
//      it has one: no Dock icon, never activated for a window;
//   2. reveals a window the way the operating system keeps out of the way: never, where a shown
//      window would activate even such an app, or shown without activating the app;
//   3. switches background throttling off, so a hidden or occluded window keeps drawing frames and
//      a measurement describes an unthrottled renderer;
//   4. puts no menu-bar icon up, where each launch would add one to the person's menu bar.
//
// `tests/helpers/launch/readiness.ts` checks on every launch that the document stays visible and
// draws. A release bundle carries none of this: all four, and each system's unobtrusive windows,
// sit behind the compile-time build flag.

import type { App, BaseWindow, WebContents } from "electron";

import type { MainOperatingSystem, UnobtrusiveWindows } from "../operating-system/contract.js";

/**
 * The environment variable the automated tiers set to `"1"`. The harnesses that spawn Electron
 * import it, so a rename is a compile error rather than a tier that steals focus again.
 */
export const UNOBTRUSIVE_WINDOWS_ENV = "SIDEKICKS_UNOBTRUSIVE_WINDOWS";

/** The part of the operating system a reveal reads. */
type RevealingOperatingSystem = Pick<MainOperatingSystem, "unobtrusiveWindows">;

/** Whether the automated tiers asked this launch to keep out of the way; only `"1"` opts in. */
function isUnobtrusiveRequested(environment: NodeJS.ProcessEnv): boolean {
  return environment[UNOBTRUSIVE_WINDOWS_ENV] === "1";
}

/** The system's unobtrusive windows when this launch asked for them; absent otherwise. */
function requestedUnobtrusiveWindows(
  environment: NodeJS.ProcessEnv,
  operatingSystem: RevealingOperatingSystem,
): UnobtrusiveWindows | undefined {
  return isUnobtrusiveRequested(environment) ? operatingSystem.unobtrusiveWindows : undefined;
}

/** The kept state a window is revealed into, beyond its rectangle. */
export interface RevealState {
  readonly isMaximized: boolean;
  readonly isFullScreen: boolean;
}

/**
 * Puts a window on screen the way this launch asked for, maximized or fullscreen when its kept
 * place was. Called by `./factory.ts` as it builds a window a person sees.
 * Maximizing shows a window, so the kept state is applied only where the window is shown.
 */
export function revealWindow(
  baseWindow: Pick<BaseWindow, "show" | "showInactive" | "maximize" | "setFullScreen">,
  state: RevealState,
  operatingSystem: RevealingOperatingSystem,
): void {
  // The flag is tested inline as a literal in each wrapper: Vite substitutes it textually, so
  // a release bundle reads `if (false)` and Rollup drops the branch and the variable name.
  // Behind a helper the environment read would survive into the release binary.
  if (__TEST_TIER_BUILD__) {
    const reveal = requestedUnobtrusiveWindows(process.env, operatingSystem)?.reveal;
    if (reveal === "hidden") {
      // Left as constructed; with throttling off it paints at full rate once loaded.
      return;
    }
    if (reveal === "inactive") {
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
  operatingSystem: RevealingOperatingSystem,
): void {
  if (__TEST_TIER_BUILD__) {
    const reveal = requestedUnobtrusiveWindows(process.env, operatingSystem)?.reveal;
    if (reveal === "hidden") {
      return;
    }
    if (reveal === "inactive") {
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
 * Called from `./factory.ts` right after construction, before the load. The release arm touches
 * nothing, so an ordinary window keeps Chromium's default throttling.
 */
export function applyRevealPreferences(
  webContents: Pick<WebContents, "setBackgroundThrottling">,
): void {
  if (__TEST_TIER_BUILD__ && isUnobtrusiveRequested(process.env)) {
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
  operatingSystem: RevealingOperatingSystem,
): void {
  if (__TEST_TIER_BUILD__) {
    const policy = requestedUnobtrusiveWindows(process.env, operatingSystem)?.activationPolicy;
    if (policy !== undefined) {
      app.setActivationPolicy(policy);
    }
  }
}

/**
 * Whether this launch puts the menu-bar icon up: where the system has one, unless a test build was
 * asked to keep out of the way.
 */
export function isMenuBarIconShown(
  operatingSystem: Pick<MainOperatingSystem, "hasMenuBarIcon">,
): boolean {
  if (!operatingSystem.hasMenuBarIcon) {
    return false;
  }
  if (__TEST_TIER_BUILD__) {
    return !isUnobtrusiveRequested(process.env);
  }
  return true;
}
