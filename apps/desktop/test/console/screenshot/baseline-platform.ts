// Where a screenshot baseline is allowed to come from, in one place.
//
// Not a test file — no `include` glob reaches it. It is imported by every file in
// the screenshot tier, because the platform pin is a property of the TIER and not
// of any one family's captures: a second family repeating the rule is a second
// place it can be relaxed, and the relaxation would be invisible — a tier that
// compared on a platform whose references nobody commits reports a pass having
// compared nothing.
//
// WHY ONE PINNED PLATFORM
//
// References are keyed by browser AND platform, and font rasterisation differs
// enough between platforms that one image cannot serve two. Committing a baseline
// per platform would mean reviewing every visual change three times over images
// nobody can regenerate locally, so this tier is pinned to ONE: `darwin`, which is
// the platform whose references are committed and the platform CI runs it on
// (`.github/workflows/ci.yml`, the `console-screenshot-macos` job). On any other
// platform the baseline comparisons SKIP with a stated reason.
//
// WHO MINTS A REFERENCE
//
// `darwin` is not one machine. The committed images are the ones GitHub's
// `macos-15` runner renders, and that runner is the AUTHORITY, so a reference
// minted anywhere else is one no CI run will reproduce. They are refreshed by
// dispatching `.github/workflows/console-screenshot-baselines.yml` with
// `mode: regenerate` on the branch that changes them, reading every image in the
// artifact it uploads, and committing that tree. A local Mac run is ADVISORY: it is
// a later macOS with a different system UI face, and the residue is a handful of
// pixels on the one glyph that comes from the host's font rather than the console's.

import type { TestContext } from "vitest";
import { server } from "vitest/browser";

/**
 * The one platform whose references are committed, and the one CI compares on.
 *
 * Stated once and read by both the skip guard and the messages it produces, so the
 * name a skipped run prints and the name the guard tests are the same string.
 */
export const PINNED_BASELINE_PLATFORM = "darwin";

/** The run's resolved snapshot-update mode — `none`, `new`, or `all`. */
export const screenshotUpdateMode: string = server.config.snapshotOptions.updateSnapshot;

/** Whether this host is one the committed references cannot serve. */
export const isOffPinnedPlatform: boolean = server.platform !== PINNED_BASELINE_PLATFORM;

/** Why the comparisons did not run here. One sentence, carried on both channels. */
export const OFF_PLATFORM_REASON: string =
  `[console-screenshot] baseline comparisons skipped: references are committed for ` +
  `${PINNED_BASELINE_PLATFORM} and this host is ${server.platform}. This tier compares on ` +
  `${PINNED_BASELINE_PLATFORM} only — capturing here would compare against nothing.`;

/**
 * Skip a baseline comparison that has no committed reference on this host.
 *
 * A skip with a NOTE rather than `describe.skipIf`, because the reason is the whole
 * point: a reader of a green run on Linux has to be able to see that the comparisons
 * did not run and why, and a suite that is simply absent from the report reads
 * exactly like one that passed.
 */
export function skipOffPinnedPlatform(context: TestContext): void {
  context.skip(isOffPinnedPlatform, OFF_PLATFORM_REASON);
}

/**
 * Say once, at collection, that this file's comparisons did not run.
 *
 * The terminal reporter prints a bare "skipped" count, which a reader cannot tell
 * from a tier that was quietly switched off, so the reason also goes to the one
 * channel that reporter forwards.
 */
export function announceOffPinnedPlatform(): void {
  if (isOffPinnedPlatform) {
    console.warn(OFF_PLATFORM_REASON);
  }
}

/**
 * The element a capture is taken of, or a throw.
 *
 * A throw rather than the assert-then-return-early shape, which turns "the surface
 * did not mount" into a test that passes having screenshotted nothing.
 */
export function requireCapturedElement(container: HTMLElement, selector: string): Element {
  const element = container.querySelector(selector);
  if (element === null) {
    throw new Error(
      `the console rendered no ${selector} element, so there is nothing for this tier to compare`,
    );
  }
  return element;
}
