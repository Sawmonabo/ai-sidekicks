// What THIS run of the screenshot tier concluded about its host, said once.
//
// Not a test file — no `include` glob reaches it. `baseline-platform.ts` beside it
// owns the pure half: the two variables, the runner they name, and a predicate that
// takes its reading as an argument so all three states can be driven in a suite.
// This module owns the half that can only be read from inside the page — the
// resolved environment and the snapshot-update mode, both off `vitest/browser`'s
// `server` — and the three values that reading produces.
//
// IT IS A MODULE BECAUSE THE TIER HAS MORE THAN ONE SUITE. `frame.test.tsx` pins the
// frame and the palette; each view family pins its own surfaces beside it. Every one
// of them needs the same skip guard and the same sentence, and a per-file copy is a
// second chance for the predicate and the reason it prints to drift apart — a skip
// whose sentence names a host the guard is no longer testing. It is also what makes
// the notice's "once" true: a latch inside a suite fires once per SUITE, so the
// paragraph that exists to make a skipped run legible was printed once per file.

import { server } from "vitest/browser";
import type { TestContext } from "vitest";

import { baselineSkipReason, comparesBaselines, readBaselineHost } from "./baseline-platform.js";

/** The run's resolved snapshot-update mode — the branch `frame.test.tsx` names. */
export const screenshotUpdateMode: string = server.config.snapshotOptions.updateSnapshot;

/**
 * What this host declared about itself.
 *
 * Off `server.config.env` rather than `process.env`, which does not exist in the
 * page: this tier runs its tests inside a real browser, and the environment reaches
 * it as Vite's resolved env.
 */
const baselineHost = readBaselineHost(server.config.env);

/** Whether this host is one whose comparisons mean anything. */
const comparesHere: boolean = comparesBaselines(baselineHost);

/** Why they did not run here. One sentence, carried on both channels. */
const SKIP_REASON: string = baselineSkipReason(baselineHost);

/**
 * Skip a baseline comparison on a host that cannot reproduce the references.
 *
 * A skip with a NOTE rather than `describe.skipIf`, because the reason is the whole
 * point: a reader of a green run has to be able to see that the comparisons did not
 * run and why, and a suite that is simply absent from the report reads exactly like
 * one that passed. The note reaches structured reporters; the terminal one prints a
 * bare "skipped" count, which is why every suite also says it once on the console
 * channel that reporter forwards.
 */
export function skipOffBaselineHost(context: TestContext): void {
  context.skip(!comparesHere, SKIP_REASON);
}

/**
 * A sentence this run says at most once, however many suites ask for it.
 *
 * A class with a private field rather than a module-level `let`, which
 * `apps/desktop/AGENTS.md` rejects — and it takes its writer as an argument rather
 * than reaching for `console` itself, so the latch can be driven without capturing a
 * global. A notice built with no message says nothing at all, which is the
 * comparing-host case: the absence of a reason and the presence of one already said
 * are two different silences, and folding them into one flag is how the guarantee in
 * the name gets lost again.
 */
export class RunScopedNotice {
  #alreadySaid = false;
  readonly #message: string | undefined;

  constructor(message: string | undefined) {
    this.#message = message;
  }

  say(write: (message: string) => void): void {
    if (this.#message === undefined || this.#alreadySaid) {
      return;
    }
    this.#alreadySaid = true;
    write(this.#message);
  }
}

/** This run's skip sentence, or nothing at all where the references serve. */
const offBaselineHostNotice = new RunScopedNotice(comparesHere ? undefined : SKIP_REASON);

/**
 * Say the reason once at collection, on the channel the terminal reporter forwards.
 *
 * Without it a skipped run reports a bare skipped count and nothing else, which a
 * reader cannot tell from a tier that was quietly switched off. ONCE for the run and
 * not once per caller: every suite in the tier calls this during collection, so an
 * unlatched body printed the same paragraph once per suite and the note that exists
 * to make a skipped run legible was the noisiest thing in the report.
 */
export function warnOnceOffBaselineHost(): void {
  offBaselineHostNotice.say((message) => {
    console.warn(message);
  });
}
