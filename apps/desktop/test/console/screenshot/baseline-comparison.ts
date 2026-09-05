// The verdict of `baseline-platform.ts`, read once for the whole tier.
//
// Two modules rather than one, and the seam is the environment: the pin beside
// this file is a pure predicate over a record, which is what lets the Vitest
// configuration import its prefix constant and what lets its own cases drive all
// three host states. THIS module is the browser-side half — it reads the running
// page's env and snapshot mode off `vitest/browser`'s `server`, so importing it
// from a configuration module would evaluate `server` in Node, where it does not
// exist. Folding the two together is therefore not a simplification; it is the
// config import breaking at load.
//
// Every file in this tier reads its verdict HERE rather than restating it. A
// second copy of the skip guard would be a second place the tier could be
// relaxed, and the relaxation would be invisible — a suite that compared on a
// host whose references nobody commits reports a pass having compared nothing,
// and one that skipped without saying so reads exactly like one that passed.

import type { TestContext } from "vitest";
import { server } from "vitest/browser";

import { baselineSkipReason, comparesBaselines, readBaselineHost } from "./baseline-platform.js";

/**
 * What this host declared about itself.
 *
 * Off `server.config.env` rather than `process.env`, which does not exist in the
 * page: this tier runs its tests inside a real browser, and the environment
 * reaches it as Vite's resolved env.
 */
const baselineHost = readBaselineHost(server.config.env);

/** The run's resolved snapshot-update mode — `none`, `new`, or `all`. */
export const screenshotUpdateMode: string = server.config.snapshotOptions.updateSnapshot;

/** Whether this host is one whose comparisons mean anything. */
export const comparesBaselinesHere: boolean = comparesBaselines(baselineHost);

/** Why they did not run here. One sentence, carried on both channels. */
export const BASELINE_SKIP_REASON: string = baselineSkipReason(baselineHost);

/**
 * Skip a baseline comparison on a host that cannot reproduce the references.
 *
 * A skip with a NOTE rather than `describe.skipIf`, because the reason is the
 * whole point: a reader of a green run has to be able to see that the comparisons
 * did not run and why, and a suite that is simply absent from the report reads
 * exactly like one that passed. The note reaches structured reporters; the
 * terminal one prints a bare "skipped" count, which is why every suite here also
 * says it once through {@link announceSkippedBaselines}.
 */
export function skipOffBaselineHost(context: TestContext): void {
  context.skip(!comparesBaselinesHere, BASELINE_SKIP_REASON);
}

/**
 * Say once, at collection, that this file's comparisons did not run.
 *
 * The terminal reporter prints a bare "skipped" count, which a reader cannot tell
 * from a tier that was quietly switched off, so the reason also goes to the one
 * channel that reporter forwards.
 */
export function announceSkippedBaselines(): void {
  if (!comparesBaselinesHere) {
    console.warn(BASELINE_SKIP_REASON);
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
