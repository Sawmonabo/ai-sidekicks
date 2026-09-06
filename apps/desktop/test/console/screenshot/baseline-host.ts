// What THIS run's host is, read once for the whole screenshot tier.
//
// `baseline-platform.ts` beside it is a pure reading of an environment record and has
// to stay one: `vitest/console-projects.ts` imports its env prefix while Vitest
// RESOLVES ITS CONFIG, which happens in Node, and `vitest/browser` throws outright
// when it is imported outside browser mode — so a binding folded into that module
// would take down every project in the package, including the ones that never
// screenshot anything. The rule lives there; the reading of this run lives here, in a
// module only test files import, and they run in the page.
//
// IT IS A MODULE BECAUSE THE TIER HAS MANY SUITES. `frame.test.tsx` pins the frame and
// the palette, and each view family pins its own surfaces beside it. Every one of them
// needs the same skip guard, the same sentence, and the same "capture this element or
// throw", and a per-file copy is another chance for the predicate and the reason it
// prints to drift apart — a skip whose sentence names a host the guard is no longer
// testing. Four branches hoisted this same reading under four different names before
// it landed here once, which is the shape of the defect rather than an anecdote.
//
// "ONCE" MEANS ONCE PER FILE, WHICH IS THE WIDEST SCOPE THIS TIER HAS — never once per
// run. Browser mode isolates every test file into its own page and module graph, so
// module scope IS file scope here and this module is evaluated afresh per file. A
// skipping run therefore prints one paragraph per skipping FILE, which is what a
// reader needs, since a file that ran and skipped is exactly what a bare skipped count
// does not distinguish. The latch bounds the file: a file whose suites each ask says
// it once rather than once per suite.
//
// AND A PARAMETERISED PAIR IN `baseline-platform.ts` WAS THE FIFTH SHAPE, considered and
// not taken. `skipOffBaselineHost(context, host)` and `announceOffBaselineHost(host)`
// keep that module import-free, which is true and is not the deciding property. Two
// things fail there. A free function has nowhere to keep a latch, so the announcement
// says its paragraph once per SUITE and a file with three of them prints three; and
// threading the host through every call leaves each test file reading
// `server.config.env` for itself, which is one more copy per file of the reading this
// module exists to have exactly one of, and one more chance for the skip and the
// sentence to be handed different hosts. The class below keeps the one virtue that
// shape had — a host supplied rather than sampled, so both branches can be driven on a
// machine that is only ever in one of them — and pays for it in a constructor rather
// than at every call site.
//
// Not a test file — no `include` glob reaches it.

import { server } from "vitest/browser";

import type { BaselineHost } from "./baseline-platform.js";
import { baselineSkipReason, comparesBaselines, readBaselineHost } from "./baseline-platform.js";

/**
 * The one thing this guard needs of a test context: a conditional skip with a note.
 *
 * Narrower than Vitest's `TestContext`, which a real case satisfies structurally, so
 * the suite beside this module can drive the real guard over all three host states
 * with a recording stand-in for the CONTEXT — never a stand-in for the guard, which
 * would prove nothing about the code the tier runs.
 */
export interface ConditionallySkippable {
  skip(condition: boolean, note: string): void;
}

/**
 * What one file does about a host whose comparisons would mean nothing.
 *
 * A class over the host reading rather than three module-level bindings, for two
 * reasons. The skip and the sentence are one decision — a guard that skipped for a
 * reason it did not print is the drift this module exists to end — and a class taking
 * its reading as an argument is the only shape whose comparing and non-comparing
 * branches can both be driven, on a machine that is only ever in one of them.
 *
 * The latch is a private field rather than a module-level `let`, which
 * `apps/desktop/AGENTS.md` rejects, and the writer is an argument rather than
 * `console` reached for directly, so the announcement can be observed without
 * capturing a global.
 */
export class BaselineComparisonGuard {
  readonly #comparesHere: boolean;
  readonly #skipReason: string;
  #alreadyAnnounced = false;

  constructor(host: BaselineHost) {
    this.#comparesHere = comparesBaselines(host);
    this.#skipReason = baselineSkipReason(host);
  }

  /** Whether this host is one whose comparisons mean anything. */
  public get comparesHere(): boolean {
    return this.#comparesHere;
  }

  /** Why they did not run here. One sentence, carried on both channels. */
  public get skipReason(): string {
    return this.#skipReason;
  }

  /**
   * Skip a baseline comparison on a host that cannot reproduce the references.
   *
   * A skip with a NOTE rather than `describe.skipIf`, because the reason is the whole
   * point: a reader of a green run has to be able to see that the comparisons did not
   * run and why, and a suite that is simply absent from the report reads exactly like
   * one that passed.
   */
  public skip(context: ConditionallySkippable): void {
    context.skip(!this.#comparesHere, this.#skipReason);
  }

  /**
   * Say the reason at most once, however many suites in this file ask.
   *
   * The note above reaches structured reporters; the terminal one prints a bare
   * "skipped" count, which a reader cannot tell from a tier that was quietly switched
   * off — so the reason also goes to the one channel that reporter forwards. Latched
   * because every suite in a file asks during collection, and an unlatched body made
   * the note that exists to make a skipped run legible the noisiest thing in the
   * report.
   *
   * A comparing host says nothing at all rather than saying an empty something: the
   * absence of a reason and the presence of one already said are two different
   * silences, and folding them into one flag is how the guarantee in the name gets
   * lost again.
   */
  public announceOnce(write: (message: string) => void): void {
    if (this.#comparesHere || this.#alreadyAnnounced) {
      return;
    }
    this.#alreadyAnnounced = true;
    write(this.#skipReason);
  }
}

/**
 * The run's resolved snapshot-update mode — `none`, `new`, or `all`.
 *
 * `frame.test.tsx`'s header owns what each branch does with a missing reference, and
 * its two guard cases are the only readers: the tier refuses `new` and probes the
 * missing-reference failure only while references are frozen.
 */
export const screenshotUpdateMode: string = server.config.snapshotOptions.updateSnapshot;

/**
 * This file's guard, built from what the host declared about itself.
 *
 * Off `server.config.env` rather than `process.env`, which does not exist in the page:
 * this tier runs its tests inside a real browser, and the environment reaches it as
 * Vite's resolved env.
 */
const guard = new BaselineComparisonGuard(readBaselineHost(server.config.env));

/** Skip this case unless the host can reproduce the committed references. */
export function skipOffBaselineHost(context: ConditionallySkippable): void {
  guard.skip(context);
}

/** Say once per file, at collection, that this file's comparisons did not run. */
export function warnOnceOffBaselineHost(): void {
  guard.announceOnce((message) => {
    console.warn(message);
  });
}

/**
 * The element a capture is taken of, or a throw.
 *
 * A throw rather than the assert-then-return-early shape, which turns "the surface did
 * not mount" into a test that passes having screenshotted nothing.
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
