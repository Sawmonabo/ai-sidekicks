// The rendering conditions the screenshot tier's references are minted under.
//
// Its own module beside `browser-mode.ts` because a reference image is only a gate
// while the next run renders under the same conditions. Everything here is a value
// the tier ALREADY depended on and did not state.
//
// These are the conditions Playwright can be TOLD — a context option, set once when
// the page is built. The one condition that lives in the page instead is the
// typeface, which is a custom property on the document; it is pinned per test from
// `test/console/screenshot/capture-faces.ts`, and that module says why a runner pin
// was not enough on its own.

import type { PlaywrightProviderOptions } from "@vitest/browser-playwright";

import {
  CAPTURE_WINDOW_HEIGHT_CEILING,
  stabilityWaitMsFor,
} from "../test/console/screenshot/capture-viewport.js";
import { BROWSER_MODE_VIEWPORT } from "./browser-mode.js";

/**
 * The rendering conditions the screenshot tier's references are minted under.
 *
 * Everything here is a value the tier ALREADY depended on and did not state, which
 * is the whole reason it is stated: a reference image is only a gate if the next
 * run renders under the same conditions, and a condition inherited from a library
 * default is one an upgrade can move without anyone editing this repository.
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
 * reference for a tier whose comment says it measures 1440×900. A page at least as
 * large as the iframe on both axes makes that scale exactly 1 and the capture 1:1.
 *
 * WHICH IS WHY THE HEIGHT IS THE CEILING RATHER THAN THE IFRAME'S 900. The console
 * is still MEASURED in a 1440×900 window — that is `BROWSER_MODE_VIEWPORT`, and it
 * is what the iframe is sized to for every capture that fits. But a surface taller
 * than the window has to be laid out and painted whole before Playwright clips it,
 * or the rows past the window's edge come back as page background — which is what
 * every reference over 900 px tall carried until `settled-capture.ts` began opening
 * the tester window for one. That grown window is scaled by the formula above, so
 * the page it sits in has to be able to hold the tallest one this tier will open.
 * `capture-viewport.ts` owns that number and both halves read it from there. The
 * width is untouched: a capture never widens its window, so the page is exactly as
 * wide as the console is measured, and the surrounding page is never in an image —
 * an element screenshot is clipped to the element.
 *
 * The other three are Playwright's current defaults, restated so they are pinned by
 * this file rather than by the version range: `deviceScaleFactor` because it
 * multiplies straight into the reference's dimensions (`screenshotOptions.scale` is
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
    // The two the tier depended on and did not state, added after a reference
    // was minted whose only difference from its sibling was the HOUR DIGITS of a
    // rendered timestamp. `Intl.DateTimeFormat` with no `timeZone` reads the
    // host's, so a capture of any surface carrying a formatted time was a
    // recording of where the machine was — and the runner that owns these
    // references runs in UTC, which is what makes UTC the pin rather than a
    // preference. `locale` rides beside it for the same reason one step further
    // out: the month name, the digit shapes, and the 12-versus-24-hour clock are
    // all locale-resolved, and a runner whose locale moved would move every one
    // of them at once.
    timezoneId: "UTC",
    locale: "en-US",
  },
};

/**
 * How close a capture has to be to its reference to count as the same image.
 *
 * ZERO, which is Vitest's default — pinned here rather than inherited, and pinned
 * on measurement rather than on caution. The measurements are worth carrying,
 * because they are what refuses a tolerance rather than what sizes one.
 *
 * After the pins above and the typeface pin the header names, this tier's residue
 * is SIX pixels in one reference: `palette-open-light`, comparing a macOS 26.6.1
 * host against references minted on GitHub's `macos-15` image (2026-09-06). Every
 * one of them sits on the corner of a `⌘` keycap glyph, at (992..993, 493..533),
 * which is the one character on these surfaces no stack in `tokens/palette.ts`
 * supplies: nothing self-hosts IBM Plex yet, so the sans stack resolves through
 * `system-ui` to the host's own face and its outline moves with the operating
 * system. So the residue is real and it is bounded and it is six.
 *
 * `frame-first-run-light` used to carry one more on the same glyph and no longer
 * does, which is not noise: that reading was taken while the monospace face was
 * still the host's own choice, and pinning it is what closed the difference. Both
 * frame references compare clean now, and only the sans keycap is left.
 *
 * A budget above it would have to fit UNDER the smallest change worth catching,
 * and that ceiling was measured too, by planting regressions and reading the count
 * at zero: a one-pixel rail move (`52px` → `53px`) is 3 690 and 4 594 pixels; the
 * stale palette reference this lane found — a two-command Help group that had
 * appeared since the capture — is 26 016; but a SINGLE changed glyph in a palette
 * label is **20**. Six and twenty is a window 3.3× wide, and a punctuation glyph
 * is smaller than a letter, so any budget inside it is a coin-flip on both edges.
 * There is no number here that is both useful and safe, so the tier takes none.
 *
 * What that costs is named rather than hidden: a developer Mac running this tier
 * goes red on those six pixels. That is the advisory status
 * `test/console/screenshot/frame.test.tsx`'s header describes, and the fix for a
 * reference that genuinely needs to move is to regenerate it on the runner that
 * owns it — never to widen this.
 *
 * pixelmatch's own `threshold` and `includeAA` defaults (0.1, AA pixels excluded)
 * are left alone, and one consequence of `threshold` is worth stating because it is
 * NOT this budget's doing: a 3% lightness change to `surface-raised` — the token
 * that paints the whole palette dialog — registers zero mismatched pixels here,
 * while a 20% one registers 257 070. This tier sees geometry and text far more
 * sharply than it sees a small colour delta, and lowering `threshold` to change
 * that would have to be paid for in residue.
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
 * comparison of the settled capture against the committed reference, and the restore.
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
