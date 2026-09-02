// Which host this tier may compare a baseline on, said once.
//
// Not a test file — no `include` glob reaches it. `frame.test.tsx`'s header owns the
// full reasoning (why the references are pinned to one platform, which machine is
// the authority, and how a reference is minted); this module owns the three values
// that reasoning produces, because the moment a second file in the tier needed them
// a per-file copy became two chances for one of them to drift — and a copy of the
// skip reason that no longer matched the guard would print a sentence about a
// platform the guard was not testing.

import { server } from "vitest/browser";
import type { TestContext } from "vitest";

/**
 * The one platform whose references are committed, and the one CI compares on.
 *
 * Stated once and read by both the skip guard and the messages it produces, so the
 * name a skipped run prints and the name the guard tests are the same string.
 */
const PINNED_BASELINE_PLATFORM = "darwin";

/** The run's resolved snapshot-update mode — the branch `frame.test.tsx` names. */
export const screenshotUpdateMode: string = server.config.snapshotOptions.updateSnapshot;

/** Whether this host is one the committed references cannot serve. */
const isOffPinnedPlatform: boolean = server.platform !== PINNED_BASELINE_PLATFORM;

/** Why the comparisons did not run here. One sentence, carried on both channels. */
const OFF_PLATFORM_REASON: string =
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

/**
 * Say the reason once at collection, on the channel the terminal reporter forwards.
 *
 * Without it an off-platform run reports a bare skipped count and nothing else,
 * which a reader cannot tell from a tier that was quietly switched off.
 */
export function warnOnceIfOffPinnedPlatform(): void {
  if (isOffPinnedPlatform) {
    console.warn(OFF_PLATFORM_REASON);
  }
}
