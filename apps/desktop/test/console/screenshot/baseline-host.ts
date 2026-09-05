// What THIS run's host is, read once for the whole tier.
//
// `baseline-platform.ts` beside it is a pure reading of an environment record and has
// to stay one: `vitest/console-projects.ts` imports its env prefix while Vitest
// RESOLVES ITS CONFIG, which happens in Node, and `vitest/browser` throws outright
// when it is imported outside browser mode — so a binding folded into that module
// takes down every project in the package, including the ones that never screenshot
// anything. The rule lives there; the reading of this run lives here, in a module
// only test files import, and they run in the page.
//
// It is a module rather than a copy in each suite because two files in this directory
// ask the same question — `frame.test.tsx` for the frame and the first-run scenario,
// `browser-terminal.test.tsx` for the browser-terminal family's three surfaces — and a
// per-file copy is two chances for the sentence a skipped run prints to stop matching
// the predicate that skipped it. That is the defect `baseline-platform.ts`'s own header
// names, one level up.
//
// Not a test file — no `include` glob reaches it.

import type { TestContext } from "vitest";
import { server } from "vitest/browser";

import { baselineSkipReason, comparesBaselines, readBaselineHost } from "./baseline-platform.js";

/** The run's resolved snapshot-update mode — the branch `frame.test.tsx` names. */
export const screenshotUpdateMode: string = server.config.snapshotOptions.updateSnapshot;

/**
 * What this host declared about itself.
 *
 * Off `server.config.env` rather than `process.env`, which does not exist in the page:
 * this tier runs its tests inside a real browser, and the environment reaches it as
 * Vite's resolved env.
 */
const thisHost = readBaselineHost(server.config.env);

/** Whether this host is one whose comparisons mean anything. */
const comparesHere: boolean = comparesBaselines(thisHost);

/** Why they did not run here. One sentence, carried on both channels. */
const SKIP_REASON: string = baselineSkipReason(thisHost);

/**
 * Skip a baseline comparison on a host that cannot reproduce the references.
 *
 * A skip with a NOTE rather than `describe.skipIf`, because the reason is the whole
 * point: a reader of a green run has to be able to see that the comparisons did not
 * run and why, and a suite that is simply absent from the report reads exactly like
 * one that passed. The note reaches structured reporters; the terminal one prints a
 * bare "skipped" count, which is why each suite also says it once on the console
 * channel that reporter forwards.
 */
export function skipOffBaselineHost(context: TestContext): void {
  context.skip(!comparesHere, SKIP_REASON);
}

/**
 * Say the reason once at collection, on the channel the terminal reporter forwards.
 *
 * Without it a skipped run reports a bare skipped count and nothing else, which a
 * reader cannot tell from a tier that was quietly switched off.
 */
export function warnOnceOffBaselineHost(): void {
  if (!comparesHere) {
    console.warn(SKIP_REASON);
  }
}
