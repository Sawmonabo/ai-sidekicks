// The baseline guard, over all three states the tier can be in.
//
// A guard that only ever runs in one environment is a guard nobody has seen the
// other branches of, and this one has three: the runner that mints the references,
// a host that declared nothing, and a developer who asked for the comparison
// anyway. The predicate takes its reading as an argument precisely so all three
// can be driven here rather than inferred from whichever machine is running.
//
// The states are named by what they MEAN and not by what they set — `on the runner`
// rather than `runner is macos-15` — because the failure this replaced was exactly
// a mismatch between what a variable said and what the tier concluded from it.

import { describe, expect, it } from "vitest";
import { server } from "vitest/browser";

import {
  baselineSkipReason,
  comparesBaselines,
  readBaselineHost,
  BASELINE_RUNNER_VARIABLE,
  BROWSER_VISIBLE_ENV_PREFIX,
  LOCAL_COMPARISON_OPT_IN,
  LOCAL_COMPARISON_VARIABLE,
  PINNED_BASELINE_RUNNER,
} from "./baseline-platform.js";

/** The three states, spelled as an environment record the way the tier sees one. */
const ON_THE_RUNNER = { [BASELINE_RUNNER_VARIABLE]: PINNED_BASELINE_RUNNER };
const ON_A_HOST_THAT_DECLARED_NOTHING = {};
const OPTED_IN_LOCALLY = { [LOCAL_COMPARISON_VARIABLE]: LOCAL_COMPARISON_OPT_IN };

describe("screenshot baselines — the three states", () => {
  it("compares on the runner that mints the references", () => {
    expect(comparesBaselines(readBaselineHost(ON_THE_RUNNER))).toBe(true);
  });

  it("skips on a host that declared no runner", () => {
    // The state a developer Mac is in, and the whole point of the change: `darwin`
    // is not `macos-15`, and the references belong to the second.
    expect(comparesBaselines(readBaselineHost(ON_A_HOST_THAT_DECLARED_NOTHING))).toBe(false);
  });

  it("compares when a developer asks for it, having declared no runner", () => {
    expect(comparesBaselines(readBaselineHost(OPTED_IN_LOCALLY))).toBe(true);
  });

  it("negative control: another runner class is not the pinned one", () => {
    // A job that copies the screenshot job's setup onto `ubuntu-latest` and keeps
    // the `env:` block would otherwise compare against images that runner never
    // rendered, and report the font stack as a regression.
    expect(
      comparesBaselines(readBaselineHost({ [BASELINE_RUNNER_VARIABLE]: "ubuntu-latest" })),
    ).toBe(false);
    expect(comparesBaselines(readBaselineHost({ [BASELINE_RUNNER_VARIABLE]: "macos-26" }))).toBe(
      false,
    );
  });

  it("negative control: only one value opts in", () => {
    // Every one of these is a non-empty string, so a truthiness check would read
    // three of the four as consent — and two of them are typed to mean the
    // opposite.
    for (const value of ["0", "false", "", "true", "yes"]) {
      expect(comparesBaselines(readBaselineHost({ [LOCAL_COMPARISON_VARIABLE]: value }))).toBe(
        false,
      );
    }
  });

  it("negative control: the reading takes these two names and no others", () => {
    // Without this the guard could be reading a neighbouring variable and passing
    // above by coincidence — the decoys here are the shapes a rename would leave
    // behind.
    const host = readBaselineHost({
      SIDEKICKS_SCREENSHOT_RUNNER: PINNED_BASELINE_RUNNER,
      SIDEKICKS_SCREENSHOT_BASELINE: PINNED_BASELINE_RUNNER,
      SIDEKICKS_SCREENSHOT_COMPARE_BASELINES: LOCAL_COMPARISON_OPT_IN,
      CI: "true",
      RUNNER_OS: "macOS",
    });
    expect(host).toStrictEqual({ runner: undefined, localOptIn: undefined });
    expect(comparesBaselines(host)).toBe(false);
  });
});

describe("screenshot baselines — what a skipped run says", () => {
  it("names the runner it wanted, what it got, and how to ask anyway", () => {
    // A skip whose reason does not carry the opt-in reads as a tier that was
    // switched off, and the reader of it is usually the person who wanted the
    // comparison.
    const reason = baselineSkipReason(readBaselineHost(ON_A_HOST_THAT_DECLARED_NOTHING));
    expect(reason).toContain(PINNED_BASELINE_RUNNER);
    expect(reason).toContain(LOCAL_COMPARISON_VARIABLE);
    expect(reason).toContain("no runner");
  });

  it("negative control: the reason reads the host rather than reciting a constant", () => {
    // Two hosts, two sentences. A fixed string would satisfy the case above and
    // tell a reader on a mis-declared runner nothing about why they are here.
    const declaredNothing = baselineSkipReason(readBaselineHost(ON_A_HOST_THAT_DECLARED_NOTHING));
    const declaredAnother = baselineSkipReason(
      readBaselineHost({ [BASELINE_RUNNER_VARIABLE]: "ubuntu-latest" }),
    );
    expect(declaredAnother).toContain('"ubuntu-latest"');
    expect(declaredAnother).not.toBe(declaredNothing);
  });
});

describe("screenshot baselines — the channel the variables arrive by", () => {
  it("names both variables under the prefix this tier's config publishes", () => {
    // The silent failure this design can have. Vite hands the page only what its
    // `envPrefix` admits, so a variable renamed off this prefix is invisible here:
    // every comparison would skip and the required check would go green having
    // compared nothing. `vitest/console-projects.ts` imports the same constant, so
    // the widening cannot drift from the names — this is what catches a rename of
    // one name and not the other.
    expect(BASELINE_RUNNER_VARIABLE.startsWith(BROWSER_VISIBLE_ENV_PREFIX)).toBe(true);
    expect(LOCAL_COMPARISON_VARIABLE.startsWith(BROWSER_VISIBLE_ENV_PREFIX)).toBe(true);
  });

  it("reads the live environment through the same record the tier hands it", () => {
    // Non-vacuity for the whole file: every case above drives a literal, and this
    // is the one that proves the shape those literals imitate is the shape the tier
    // actually reads. `process` does not exist in this page, so `server.config.env`
    // is not a convenience — it is the only channel there is.
    expect(typeof (globalThis as { process?: unknown }).process).toBe("undefined");
    expect(() => readBaselineHost(server.config.env)).not.toThrow();
  });
});
