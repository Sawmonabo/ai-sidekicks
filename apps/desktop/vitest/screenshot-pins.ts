// The rendering conditions the screenshot tier's captures are taken under.
//
// Its own module beside `browser-mode.ts`. The tier compares nothing since
// 2026-09-09 — it writes a picture of every surface into the gitignored
// `__screenshots__/` for a person to look at — and these conditions still decide
// what is IN that picture: a capture rendered in the host's time zone shows the
// host's clock where the console's state should be, and one taken through a
// fractional downscale shows every glyph resampled off the pixel grid.
//
// These are the conditions Playwright can be TOLD — a context option, set once when
// the page is built. The typeface is deliberately NOT among them any more: the
// console self-hosts both families through `console/frame/bindings/typeface.ts`, so
// a capture shows the product's own faces, and a pin here would show a face the
// product does not ship.

import process from "node:process";

import type { PlaywrightProviderOptions } from "@vitest/browser-playwright";

import {
  CAPTURE_WINDOW_HEIGHT_CEILING,
  stabilityWaitMsFor,
} from "../test/console/screenshot/capture-viewport.js";
import { BROWSER_MODE_VIEWPORT } from "./browser-mode.js";

/**
 * The rendering conditions the screenshot tier's captures are taken under.
 *
 * Everything here is a value the tier ALREADY depended on and did not state, which
 * is the whole reason it is stated: a condition inherited from a library default is
 * one an upgrade can move without anyone editing this repository, and a capture
 * taken under a moved condition is a picture of something other than the console.
 *
 * `viewport` is the load-bearing one, and it is not the same knob as
 * `BROWSER_MODE_VIEWPORT`. That one sizes the TESTER IFRAME; this one sizes the
 * Playwright page the iframe lives in, and the provider deliberately does not
 * derive the second from the first. Vitest then fits the iframe into the page with
 * `scale = min(1, pageWidth / iframeWidth, pageHeight / iframeHeight)` and applies
 * it as a CSS `transform: scale()`. Against Playwright's own 1280×720 default that
 * resolved to 0.8, so a console laid out at 1440×900 was captured through a
 * fractional downscale — every border and glyph resampled off the pixel grid, which
 * is exactly the operation two Skia/CoreText builds disagree about, and a 1152×720
 * capture for a tier whose comment says it measures 1440×900. A page at least as
 * large as the iframe on both axes makes that scale exactly 1 and the capture 1:1.
 *
 * WHICH IS WHY THE HEIGHT IS THE CEILING RATHER THAN THE IFRAME'S 900. The console
 * is still MEASURED in a 1440×900 window — that is `BROWSER_MODE_VIEWPORT`, and it
 * is what the iframe is sized to for every capture that fits. But a surface taller
 * than the window has to be laid out and painted whole before Playwright clips it,
 * or the rows past the window's edge come back as page background — which is what
 * every capture over 900 px tall carried until `settled-capture.ts` began opening
 * the tester window for one. That grown window is scaled by the formula above, so
 * the page it sits in has to be able to hold the tallest one this tier will open.
 * `capture-viewport.ts` owns that number and both halves read it from there. The
 * width is untouched: a capture never widens its window, so the page is exactly as
 * wide as the console is measured, and the surrounding page is never in an image —
 * an element screenshot is clipped to the element.
 *
 * The other three are Playwright's current defaults, restated so they are pinned by
 * this file rather than by the version range: `deviceScaleFactor` because it
 * multiplies straight into the capture's dimensions (`screenshotOptions.scale` is
 * `"device"`), and the two media emulations because the console's generated base
 * stylesheet branches on `prefers-reduced-motion` and Chromium branches on forced
 * colors. `colorScheme` is deliberately ABSENT: the harness drives that per test
 * through `Emulation.setEmulatedMedia`, and a context-level value would be a second
 * writer of the same emulated media state.
 */
export const SCREENSHOT_TIER_PROVIDER_OPTIONS: PlaywrightProviderOptions = {
  contextOptions: {
    viewport: { width: BROWSER_MODE_VIEWPORT.width, height: CAPTURE_WINDOW_HEIGHT_CEILING },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
    forcedColors: "none",
    // The two the tier depended on and did not state, added after a capture was
    // taken whose only difference from its sibling was the HOUR DIGITS of a
    // rendered timestamp. `Intl.DateTimeFormat` with no `timeZone` reads the
    // host's, so a capture of any surface carrying a formatted time is a recording
    // of where the machine was rather than of what the console shows. `locale`
    // rides beside it for the same reason one step further out: the month name,
    // the digit shapes, and the 12-versus-24-hour clock are all locale-resolved.
    // `test/console/screenshot/rendering-conditions.test.ts` drives both.
    timezoneId: "UTC",
    locale: "en-US",
  },
};

/**
 * How close two consecutive captures have to be before the page counts as settled.
 *
 * NOT A GATE. Nothing this tier writes is compared against a committed image any
 * more, and `SCREENSHOT_TIER_UPDATE_MODE` below is what makes that true. What the
 * comparator still decides is STABILITY: the matcher photographs the element twice
 * and keeps going until two captures agree, so a surface mid-paint is re-taken
 * rather than written. Zero mismatched pixels is the strictest reading of "the page
 * has stopped changing", and it is also Vitest's own default — pinned here so a
 * library upgrade cannot loosen it silently.
 *
 * pixelmatch's own `threshold` and `includeAA` defaults (0.1, AA pixels excluded)
 * are left alone.
 *
 * THE ONE MATCHER OPTION THAT IS DELIBERATELY NOT HERE is `timeout`, the wait the
 * stability check is raced against. It is not a condition of the tier — it is a
 * budget for the work ONE capture does, and how much work that is depends on how
 * many windows `settled-capture.ts` had to open to hold the surface. So it is
 * passed per call from there, sized by `capture-viewport.ts`'s
 * `STABILITY_WAIT_PER_VIEWPORT_MS` and `stabilityWaitMsFor`. Restating the
 * per-window figure in this object would give the value a second home that nothing
 * reads: the matcher merges the project's options UNDER the call's, so a
 * project-level `timeout` beneath a call that always supplies one is inert.
 */
export const SCREENSHOT_TIER_MATCH_OPTIONS = {
  comparatorName: "pixelmatch",
  comparatorOptions: { allowedMismatchedPixels: 0 },
} as const;

/**
 * Everything one capture spends that is not the stability wait, in milliseconds.
 *
 * The mount, the sizing passes and their settles, the two pending-marker reads, the
 * stability comparison of the settled capture against its own retry, and the restore.
 * MEASURED RATHER THAN CHOSEN, and by the tier's own history: Vitest resolves
 * `testTimeout` to 15 000 ms under browser mode rather than to the 5 000 ms it uses
 * elsewhere (`@vitest/browser`'s peer `vitest@4.1.5`, `dist/chunks/coverage.*.js` —
 * `resolved.testTimeout ??= resolved.browser.enabled ? 15e3 : 5e3`), and every capture
 * this tier takes has always done all of that work plus a wait of up to 5 000 ms inside
 * it. So this is the figure the tier has been demonstrating is enough for the work,
 * separated out from the wait it was fused with.
 */
const CAPTURE_WORK_RESIDUAL_MS = 10_000;

/**
 * The longest stability wait this tier can hand one capture, in milliseconds.
 *
 * Derived through the shipped function rather than restated, and derived HERE rather
 * than in each reader: the tallest window a capture may open is
 * `CAPTURE_WINDOW_HEIGHT_CEILING`, a capture never widens its window, so the area
 * ratio is the height ratio and the wait is whatever `stabilityWaitMsFor` returns for
 * it. The tier's own patience below is the first reader; the architecture case that
 * holds the two against each other is the second, and a second derivation there would
 * be a test reimplementing the rule it checks.
 */
export const LONGEST_CAPTURE_STABILITY_WAIT_MS: number = stabilityWaitMsFor(
  CAPTURE_WINDOW_HEIGHT_CEILING / BROWSER_MODE_VIEWPORT.height,
);

/**
 * The patience the screenshot tier carries, derived from the longest wait it can hand out.
 *
 * WHY THE TIER CANNOT INHERIT ITS TIMEOUT ANY MORE. `settled-capture.ts` sizes each
 * capture's stability wait to the window it had to open, and the tallest window this
 * tier will open is `CAPTURE_WINDOW_HEIGHT_CEILING` — four of the window the console is
 * measured in, so four times the per-window wait. Left at the inherited 15 000 ms, a
 * capture handed a 20 000 ms wait could never spend it: Vitest's own timeout would fire
 * first and report "Test timed out", which names neither the wait nor the surface. That
 * is the inversion `test/console/launch-deadline.ts` describes for the Electron tiers,
 * reaching this one by a different route — a bound that outlives the budget enclosing it
 * is a bound nothing can reach.
 *
 * So it is DERIVED here rather than written down: the wait a capture at the ceiling is
 * given, plus what a capture spends on everything that is not waiting. A capture that
 * genuinely never settles therefore fails with the matcher's own sentence and the number
 * it raced against, which is the whole point of sizing the wait in the first place.
 *
 * `hookTimeout` takes the same figure, on `launch-deadline.test.ts`'s reasoning: a
 * guarantee that holds in a test body and not in the hook beside it is not a guarantee,
 * and this tier's suites mount their surfaces in hooks.
 */
export const SCREENSHOT_TIER_TIMEOUT_MS: number =
  LONGEST_CAPTURE_STABILITY_WAIT_MS + CAPTURE_WORK_RESIDUAL_MS;

/**
 * The tier writes its captures and compares them against nothing.
 *
 * `all` is the snapshot-update mode in which `toMatchScreenshot` writes the image
 * and passes whether or not one was already on disk — a missing picture is written,
 * a changed one is overwritten, and neither outcome fails a run. That is the whole
 * of what "a local capture aid" means mechanically, and it is applied HERE rather
 * than only in the `test:console-screenshot` script so that a bare
 * `vitest run --project=console-screenshot` behaves identically.
 *
 * AN ENVIRONMENT VARIABLE RATHER THAN A PROJECT OPTION, because Vitest offers no
 * per-project one. `update` is listed among the options a project may not declare,
 * and `resolveConfig` reads exactly two sources — `resolved.update || process.env
 * .UPDATE_SNAPSHOT` — of which the first resolves from the ROOT config only
 * (measured: a project-level `update: true` typechecks through a spread and still
 * resolves `new`, which fails a run on a picture it has just written). Setting it on
 * the root config is the alternative the types admit and it moves every project in
 * this package into update mode, which is the same reach as this line with none of
 * the reason stated beside it.
 *
 * WHAT THAT REACH COSTS, AND WHAT PAYS FOR IT. The variable is process-wide, so a
 * text snapshot anywhere in this package would rewrite itself instead of failing.
 * There is none, and `eslint.config.mjs` refuses `toMatchSnapshot`,
 * `toMatchInlineSnapshot`, and `toMatchFileSnapshot` across the package so there
 * cannot be one without that rule being answered first.
 *
 * `??=` rather than `=`: a developer who typed `UPDATE_SNAPSHOT=none` in front of
 * the command asked for something and gets it.
 */
export function pinScreenshotTierUpdateMode(): void {
  process.env["UPDATE_SNAPSHOT"] ??= "all";
}
