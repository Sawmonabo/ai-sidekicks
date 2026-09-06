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
 * reference for a tier whose comment says it measures 1440×900. Matching the page
 * to the iframe makes the scale exactly 1 and the capture 1:1.
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
    viewport: { ...BROWSER_MODE_VIEWPORT },
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
 */
export const SCREENSHOT_TIER_MATCH_OPTIONS = {
  comparatorName: "pixelmatch",
  comparatorOptions: { allowedMismatchedPixels: 0 },
} as const;
