// Which platform the screenshot tier's references belong to, and what every file
// in the tier does on any other one.
//
// Not a test file — no `include` glob reaches it. It is imported by the tier's
// test files so all of them make the SAME decision about where a comparison is
// meaningful, for the reason `Spec-023 §Console Test Tiers` gives the tier at all:
// references are keyed by browser AND platform, font rasterisation differs enough
// between platforms that one image cannot serve two, and committing a baseline per
// platform would mean reviewing every visual change three times over images nobody
// can regenerate locally. So the tier is pinned to ONE platform, and a per-file
// copy of that pin would be N chances to pin a different one and then compare
// results as if they were comparable.
//
// WHAT IS DELIBERATELY NOT HERE. The tier's fail-closed guard — the assertion that
// the run did not resolve the `new` snapshot-update mode, and the probe that a
// reference nobody committed FAILS rather than being written — is a claim about the
// runner rather than about pixels, it holds on every platform, and it is asserted
// once for the whole tier by `frame.test.tsx`. A second file asserting it would be
// the same claim counted twice, and the second copy would be the one that goes
// stale.

import type { TestContext } from "vitest";
import { server } from "vitest/browser";

/**
 * The one platform whose references are committed, and the one CI compares on.
 *
 * Stated once and read by both the skip guard and the message it produces, so the
 * name a skipped run prints and the name the guard tests are the same string.
 *
 * `darwin` is not one machine either: the committed images are the ones GitHub's
 * `macos-15` runner renders, which is the authority `ci.yml`'s
 * `console-screenshot-macos` job compares against. A reference minted anywhere else
 * is one no CI run will reproduce; they are refreshed by dispatching
 * `.github/workflows/console-screenshot-baselines.yml` with `mode: regenerate` on
 * the branch that changes them and committing the artifact it uploads.
 */
const PINNED_BASELINE_PLATFORM = "darwin";

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
 * A skip with a NOTE rather than `describe.skipIf`, because the reason is the
 * whole point: a reader of a green run on Linux has to be able to see that the
 * comparisons did not run and why, and a suite that is simply absent from the
 * report reads exactly like one that passed. The note reaches structured
 * reporters; the terminal one prints a bare "skipped" count, which is why each
 * suite also says it once on the console channel that reporter forwards.
 */
export function skipOffPinnedPlatform(context: TestContext): void {
  context.skip(isOffPinnedPlatform, OFF_PLATFORM_REASON);
}
