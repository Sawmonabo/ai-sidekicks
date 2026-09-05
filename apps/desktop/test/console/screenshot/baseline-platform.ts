// Which hosts this tier compares references on, and why it is not a platform.
//
// WHAT THE PIN USED TO BE, AND WHY IT WAS WRONG. The tier skipped its baseline
// comparisons unless `server.platform === "darwin"`, three lines above a doc block
// that already said the authority is GitHub's `macos-15` runner and that "a
// reference minted anywhere else is one no CI run will reproduce". Those two
// sentences do not agree: a developer's Mac IS `darwin`, so the guard let the
// comparison run against images that host cannot reproduce, and the tier was red on
// every branch for reasons belonging to the machine rather than to the diff.
// Measured here on 2026-09-05, one of the three references disagrees — six pixels
// of `palette-open-light`, every one a corner of a `⌘` keycap — and the two frames
// agree exactly; other hosts and other reference vintages have shown disagreements
// three orders of magnitude larger. Which is the point: the size of the residue is
// a property of the machine and the tree, so the pin cannot be "the residue is
// small". A gate that is red for a reason the reader must know to discount is a
// gate the reader stops reading.
//
// SO THE PIN IS THE RUNNER. `SIDEKICKS_SCREENSHOT_BASELINE_RUNNER` is set by the two
// workflow jobs that run on `macos-15` — `ci.yml`'s `console-screenshot-macos`, which
// compares, and `console-screenshot-baselines.yml`'s `baselines`, which compares
// under `verify` and mints under `regenerate` — and by nothing else. It is checked by
// VALUE and not by presence, so a job that copies the setup onto another runner class
// and forgets to remove the line skips rather than comparing against images that
// runner did not render.
//
// AND A DEVELOPER CAN STILL ASK. `SIDEKICKS_SCREENSHOT_COMPARE=1` runs the
// comparisons anywhere, deliberately and unconditionally: the host that most wants it
// is the Mac whose local red this pin exists to stop being automatic, and a person who
// types that variable has said they know what they are looking at. It is not
// platform-conditioned either — a Linux host that opts in gets a wall of red against
// darwin references, which is the correct answer to that request rather than a reason
// to refuse it.
//
// WHY BOTH VARIABLES ARE READ OUT OF A RECORD rather than off `process.env` here:
// this module is imported by a BROWSER-MODE tier, where there is no `process` at all
// (measured — `typeof process` is `"undefined"` in the page). The environment reaches
// the page as Vite's resolved env, which the tier reads off `server.config.env` and
// hands in, and which carries only prefixed names — `vitest/console-projects.ts`
// widens `envPrefix` by exactly the prefix these two share. Taking the record as an
// argument is also what lets the cases below drive the real predicate over all three
// states instead of the one the machine running them happens to be in.

/**
 * The prefix both variables below share, and the reason they share it.
 *
 * Vite publishes into the page only what its `envPrefix` admits, so a variable
 * named off this prefix is invisible to a browser-mode tier — every comparison
 * would skip and the required check would go green having compared nothing.
 * `vitest/console-projects.ts` IMPORTS this constant rather than repeating the
 * string, so the widening and the names cannot drift apart, and the cases beside
 * this module assert both names still begin with it.
 */
export const BROWSER_VISIBLE_ENV_PREFIX = "SIDEKICKS_SCREENSHOT_";

/**
 * The runner whose renderings the committed references are.
 *
 * Not a platform. `darwin` is a family of machines with different system UI faces,
 * and the console's sans stack falls through to whichever one the host resolves.
 */
export const PINNED_BASELINE_RUNNER = "macos-15";

/** Set by the two jobs that run on that runner, and deliberately nowhere else. */
export const BASELINE_RUNNER_VARIABLE = "SIDEKICKS_SCREENSHOT_BASELINE_RUNNER";

/** The developer's deliberate "compare anyway — I know what I am looking at". */
export const LOCAL_COMPARISON_VARIABLE = "SIDEKICKS_SCREENSHOT_COMPARE";

/**
 * The one value that opts in.
 *
 * Exact rather than truthy: `SIDEKICKS_SCREENSHOT_COMPARE=0` and
 * `SIDEKICKS_SCREENSHOT_COMPARE=false` are both things a person types meaning the
 * opposite, and both are non-empty strings.
 */
export const LOCAL_COMPARISON_OPT_IN = "1";

/** What this host says about itself, as the two variables report it. */
export interface BaselineHost {
  /** The runner the tier is running on, as its job declared it. */
  readonly runner: string | undefined;
  /** The local opt-in, verbatim. */
  readonly localOptIn: string | undefined;
}

/** Reads the two variables out of an environment record, and nothing else from it. */
export function readBaselineHost(env: Readonly<Record<string, string | undefined>>): BaselineHost {
  return { runner: env[BASELINE_RUNNER_VARIABLE], localOptIn: env[LOCAL_COMPARISON_VARIABLE] };
}

/** Whether `host` is one whose comparisons mean something. */
export function comparesBaselines(host: BaselineHost): boolean {
  return host.runner === PINNED_BASELINE_RUNNER || host.localOptIn === LOCAL_COMPARISON_OPT_IN;
}

/**
 * Why the comparisons did not run here. One sentence, carried on both channels.
 *
 * It names the opt-in, because the reader of a skipped run is usually the developer
 * who wanted the comparison and a skip that does not say how to ask for it reads as
 * a tier that was switched off.
 */
export function baselineSkipReason(host: BaselineHost): string {
  const declared = host.runner === undefined ? "no runner" : `"${host.runner}"`;
  return (
    `[console-screenshot] baseline comparisons skipped: the committed references are what ` +
    `GitHub's ${PINNED_BASELINE_RUNNER} runner renders, and this host declared ${declared}. ` +
    `Run them anyway with ${LOCAL_COMPARISON_VARIABLE}=${LOCAL_COMPARISON_OPT_IN} — a local ` +
    `Mac renders the console's fallback face rather than the runner's, so read a small ` +
    `keycap-glyph diff as the host and anything larger as yours.`
  );
}
