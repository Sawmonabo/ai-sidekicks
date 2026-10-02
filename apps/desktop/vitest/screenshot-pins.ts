// The rendering conditions the screenshot tier's captures are taken under. The tier writes a
// picture of every surface into the gitignored `__screenshots__/` for a person to look at and
// compares nothing, but these conditions decide what is in that picture: a capture in the host's
// time zone shows the host's clock, and one through a fractional downscale shows glyphs resampled
// off the pixel grid. Only conditions Playwright can be told (a context option set when the page
// is built) belong here. The typeface does not: the app self-hosts its faces through
// `src/renderer/src/styles/typeface.ts`, so a pin would show a face the product does not ship.

import process from "node:process";

import type { PlaywrightProviderOptions } from "@vitest/browser-playwright";

import {
  CAPTURE_WINDOW_HEIGHT_CEILING,
  stabilityWaitMsFor,
} from "../tests/screenshot/capture-viewport.js";
import { BROWSER_MODE_VIEWPORT } from "./browser-mode.js";

/**
 * The rendering conditions the tier's captures are taken under, stated so a library default
 * cannot move them unnoticed.
 *
 * `viewport` sizes the Playwright page the tester iframe lives in, and is not
 * `BROWSER_MODE_VIEWPORT`, which sizes the iframe. Vitest fits the iframe into the page with
 * `scale = min(1, pageWidth / iframeWidth, pageHeight / iframeHeight)` as a CSS `transform:
 * scale()`. Against Playwright's 1280×720 default that was 0.8, so a 1440×900 window was
 * resampled off the pixel grid; a page at least as large as the iframe on both axes makes the
 * scale exactly 1. The height is `CAPTURE_WINDOW_HEIGHT_CEILING` rather than 900 because a
 * surface taller than the window is laid out whole in a grown tester window (`settled-capture.ts`)
 * and the page must hold the tallest one. The width stays at the measured 1440.
 *
 * The other options restate Playwright's current defaults: `deviceScaleFactor` multiplies into
 * the capture's dimensions (`screenshotOptions.scale` is `"device"`), and the app's base
 * stylesheet branches on `prefers-reduced-motion` while Chromium branches on forced colors.
 * `colorScheme` is absent because the harness drives it per test through
 * `Emulation.setEmulatedMedia`, and a context-level value would be a second writer.
 */
export const SCREENSHOT_TIER_PROVIDER_OPTIONS: PlaywrightProviderOptions = {
  contextOptions: {
    viewport: { width: BROWSER_MODE_VIEWPORT.width, height: CAPTURE_WINDOW_HEIGHT_CEILING },
    deviceScaleFactor: 1,
    reducedMotion: "no-preference",
    forcedColors: "none",
    // `Intl.DateTimeFormat` with no `timeZone` reads the host's, so a capture with a formatted
    // time would record where the machine was. `locale` is pinned because month names, digit
    // shapes and the 12- or 24-hour clock are locale-resolved.
    timezoneId: "UTC",
    locale: "en-US",
  },
};

/**
 * How close two consecutive captures must be before the page counts as settled. This is not a
 * gate: nothing is compared with a committed image. The matcher photographs the element twice
 * until two captures agree, so a surface mid-paint is re-taken. Zero mismatched pixels is the
 * strictest reading and Vitest's default, pinned so an upgrade cannot loosen it. pixelmatch's
 * `threshold` and `includeAA` defaults are left alone.
 *
 * `timeout` is deliberately absent: it budgets the work of one capture, which depends on how many
 * windows `settled-capture.ts` opened, so it is passed per call there (sized by
 * `stabilityWaitMsFor`). The matcher merges project options under the call's, so a project-level
 * `timeout` would be inert.
 */
export const SCREENSHOT_TIER_MATCH_OPTIONS = {
  comparatorName: "pixelmatch",
  comparatorOptions: { allowedMismatchedPixels: 0 },
} as const;

/**
 * Everything one capture spends that is not the stability wait, in milliseconds: the mount, the
 * sizing passes and settles, the pending-marker reads, the stability comparison against its retry,
 * and the restore. Vitest resolves browser-mode `testTimeout` to 15 000 ms rather than 5 000
 * (`resolved.testTimeout ??= resolved.browser.enabled ? 15e3 : 5e3`, in the vitest 4.1.11 that
 * `@vitest/browser` peers on), and every capture has done all of that plus a wait of up to
 * 5 000 ms inside it, so this is the figure the tier has shown is enough for the work.
 */
const CAPTURE_WORK_RESIDUAL_MS = 10_000;

/**
 * The longest stability wait this tier can hand one capture, in milliseconds. The tallest window
 * is `CAPTURE_WINDOW_HEIGHT_CEILING` and a capture never widens its window, so the area ratio is
 * the height ratio, and `stabilityWaitMsFor` gives the wait.
 */
export const LONGEST_CAPTURE_STABILITY_WAIT_MS: number = stabilityWaitMsFor(
  CAPTURE_WINDOW_HEIGHT_CEILING / BROWSER_MODE_VIEWPORT.height,
);

/**
 * The test and hook timeout for the screenshot tier: the longest stability wait plus what a
 * capture spends on everything else. `settled-capture.ts` sizes each capture's wait to the window
 * it opened, and the ceiling window is four times the measured one, so the wait is four times the
 * per-window wait. The inherited 15 000 ms would let Vitest's "Test timed out" fire before a
 * 20 000 ms wait could be spent, naming neither the wait nor the surface. It is derived rather
 * than written down so a capture that never settles fails with the matcher's own sentence and the
 * number it raced against. Suites here mount their surfaces in hooks, so `hookTimeout` takes the
 * same figure.
 */
export const SCREENSHOT_TIER_TIMEOUT_MS: number =
  LONGEST_CAPTURE_STABILITY_WAIT_MS + CAPTURE_WORK_RESIDUAL_MS;

/**
 * Puts the process in snapshot-update mode `all`, in which `toMatchScreenshot` writes the image
 * and passes whether or not one exists: mechanically, what "a local capture aid" means. It is
 * applied here as well as in the `test:screenshot` script so a bare
 * `vitest run --project=screenshot` behaves identically.
 *
 * It is an environment variable because Vitest offers no per-project option: a project may not
 * declare `update`, and `resolveConfig` reads `resolved.update || process.env.UPDATE_SNAPSHOT`,
 * the first from the root config only (measured: a project-level `update: true` still resolves
 * `new`, which fails a run on a picture it just wrote). The variable is process-wide, so a text
 * snapshot anywhere in this package would rewrite itself instead of failing;
 * `apps/desktop/eslint.config.mjs` refuses `toMatchSnapshot`, `toMatchInlineSnapshot` and
 * `toMatchFileSnapshot`. `??=` so a developer who typed `UPDATE_SNAPSHOT=none` gets what they
 * asked for.
 */
export function pinScreenshotTierUpdateMode(): void {
  process.env["UPDATE_SNAPSHOT"] ??= "all";
}
