// Unobtrusive windows for the automated tiers — test builds only.
//
// Every Electron tier (the smoke probe, the GC probe, end-to-end, endurance)
// launches the real shell with a real window, and a window is revealed through
// `BrowserWindow.show()`. On macOS that call ACTIVATES the application: the
// Dock icon appears, keyboard focus moves to the new window, and an operator on
// a full-screen Space is switched to the Space the window opened on. One
// aggregate `test` run launches Electron about a dozen times, every worktree
// running the gates repeats it, and each launch pulls the operator off whatever
// they were doing.
//
// The tiers therefore ask for UNOBTRUSIVE windows through one environment
// variable, and a test build honours it in three places:
//
//   1. the activation policy — macOS `accessory`, so the application has no
//      Dock icon and is never activated on a window's behalf;
//   2. the reveal itself. On macOS the window is NOT revealed at all: it stays
//      the hidden window it was constructed as, so nothing is ordered onto any
//      screen or Space and nothing can take focus. Everywhere else it is
//      revealed with `showInactive()`, which orders the window in front without
//      making it key — see the platform split below for why the two differ. The
//      policy alone is not enough: an accessory application can still be
//      activated programmatically, and `show()` is exactly such an activation;
//   3. background throttling, switched OFF for the window. Chromium answers a
//      hidden or occluded window by throttling timers and animation frames,
//      reporting the document hidden, and letting the renderer take background
//      memory reductions. A measurement taken there describes a throttled
//      renderer, not the console: a green endurance budget that means nothing,
//      which is worse than a focus steal. With throttling off, frames are still
//      drawn and swapped and the document stays `visible`, so the unrevealed
//      window runs the same code at the same rate a focused one does.
//      `test/console/electron-harness.ts` asserts both — the visibility state
//      and that animation frames are actually delivered — on every launch
//      rather than trusting it.
//
// The platform split in (2) is a measured one, not a preference. Electron's
// `disable_hidden` patch, which is what a throttling-off setting switches on,
// keeps animation frames running for an occluded, minimised, AND hidden window
// on macOS, but on Windows only for the first two — a hidden window there stops
// painting (electron/electron#31016). A never-revealed window is therefore a
// faithful measurement surface on macOS and not on Windows, so Windows keeps
// the inactive reveal. Linux runs the tiers under Xvfb, where there is no
// operator to disturb, and takes the inactive reveal as well.
//
// All three sit behind the compile-time build flags, so a release bundle carries
// neither the environment read nor the branch — the same production-safety
// shape as the smoke probe in `./index.ts`. Within a test build the variable is
// still an opt-in, so a developer running a fixture build by hand to LOOK at
// the console gets an ordinary, focused window.

import type { App, BrowserWindow, WebContents } from "electron";

// Substituted by the `define` block in `electron.vite.config.ts` for the main
// target, and by every Vitest project that reaches this module (see
// `vitest.config.ts`). Declared here rather than imported: `./index.ts` declares
// the same two names for its own probe branch, and a `declare const` is
// module-scoped, so the two declarations never meet.
declare const __SIDEKICKS_SMOKE_BUILD__: boolean;
declare const __SIDEKICKS_CONSOLE_FIXTURES__: boolean;

/**
 * The environment variable the automated tiers set to `"1"`.
 *
 * Imported by every harness that spawns Electron (`test/console/electron-harness.ts`,
 * `test/helpers/electron-probe.ts`, `test/lifecycle.gc.test.ts`) rather than
 * retyped, so a rename here is a compile error there and not a tier that
 * quietly starts stealing focus again.
 */
export const UNOBTRUSIVE_WINDOWS_ENV = "SIDEKICKS_UNOBTRUSIVE_WINDOWS";

/**
 * How a ready window is put on screen — or, for `hidden`, deliberately not.
 * `hidden` leaves the window exactly as the locked factory constructed it
 * (`show: false`); nothing is ever ordered onto a screen.
 */
type WindowRevealMode = "active" | "inactive" | "hidden";

/** The one activation policy this module ever sets; `null` means leave Electron's default. */
type ActivationPolicyChange = "accessory" | null;

/**
 * Decides how a window is revealed, from the build kind, the environment, and
 * the platform.
 *
 * Pure so the decision is testable under a unit project whose build flags are
 * both `false`: the flags are an ARGUMENT here and are read only by the
 * wrappers below. The check is against exactly the string `"1"`, the same
 * deliberate opt-in shape the smoke probe uses. A requested test build stays
 * hidden on macOS and reveals inactive elsewhere — the measured split the
 * header explains.
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
 * Decides whether the activation policy changes, from the build kind, the
 * environment, and the platform.
 *
 * Only macOS has an activation policy; Electron exposes `setActivationPolicy`
 * nowhere else, so on every other platform the answer is `null` regardless of
 * the request. On Linux the tiers run against Xvfb and on Windows a window
 * without focus is an ordinary window, so nothing is lost there.
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
 * Puts a ready window on screen the way this launch asked for.
 *
 * Called from the locked window factory's `ready-to-show` handler — the ONE
 * reveal site, so every window this process creates (main and auxiliary alike)
 * takes the same decision.
 */
export function revealWindow(
  browserWindow: Pick<BrowserWindow, "show" | "showInactive">,
  platform: NodeJS.Platform = process.platform,
): void {
  // The build flags are tested INLINE, as literals, in every wrapper: Vite
  // substitutes them textually, so a release bundle reads `if (false || false)`
  // here and Rollup drops the branch, the resolver it called, and the variable
  // name with it. Behind a helper the flags would be a call's return value and
  // the environment read would survive into the release binary — verified by
  // grepping `out/main/index.js` for the variable after `pnpm build`.
  if (__SIDEKICKS_SMOKE_BUILD__ || __SIDEKICKS_CONSOLE_FIXTURES__) {
    const mode = resolveWindowRevealMode(true, process.env, platform);
    if (mode === "hidden") {
      // Left as constructed. The document still loads, `ready-to-show` has
      // already fired, and with throttling off (below) it paints at full rate.
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
 * Keeps a window's renderer un-throttled when it will stay hidden or be
 * revealed inactive.
 *
 * Called from the locked window factory right after construction, before the
 * load starts, so no frame of the document's life runs under the default. The
 * release arm touches nothing: an ordinary window keeps Chromium's default
 * throttling, which is what a real user's backgrounded console should get.
 */
export function applyRevealPreferences(
  browserWindow: { readonly webContents: Pick<WebContents, "setBackgroundThrottling"> },
  platform: NodeJS.Platform = process.platform,
): void {
  if (
    (__SIDEKICKS_SMOKE_BUILD__ || __SIDEKICKS_CONSOLE_FIXTURES__) &&
    resolveWindowRevealMode(true, process.env, platform) !== "active"
  ) {
    browserWindow.webContents.setBackgroundThrottling(false);
  }
}

/**
 * Applies the activation policy this launch asked for. Call inside
 * `app.whenReady()`, before the first window: the policy has to be in place
 * before a reveal could activate the application, and `NSApplication` is only
 * guaranteed to exist once the app is ready.
 */
export function installActivationPolicy(
  app: Pick<App, "setActivationPolicy">,
  platform: NodeJS.Platform = process.platform,
): void {
  if (!(__SIDEKICKS_SMOKE_BUILD__ || __SIDEKICKS_CONSOLE_FIXTURES__)) {
    return;
  }
  const change = resolveActivationPolicyChange(true, process.env, platform);
  if (change !== null) {
    app.setActivationPolicy(change);
  }
}
