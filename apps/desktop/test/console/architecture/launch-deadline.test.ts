// One clock for a launch, and the arithmetic that keeps it inside its tier.
//
// A witness that renders a verdict its tier never waits to hear is no better
// than no witness. The readiness ladder ahead of it used to hand each of its
// four phases an independent 30 000 ms, so a launch was entitled to 135 000 ms
// inside a 60 000 ms tier: vitest would kill the test mid-phase and the reader
// would get "test timed out" instead of any of the sentences the witness and the
// cleanup are there to produce.
//
// `launch-deadline.ts` makes that one shared clock divided into three named
// slices, and this file holds both halves of the claim. The arithmetic half runs
// against the REAL tier timeouts — resolved out of `vitest.config.ts` through
// `createVitest`, never copied into a literal that could drift away from the
// config while still agreeing with itself. The behavioural half runs against an
// injected clock, so the phase arithmetic is checked without waiting for any of
// it to elapse.
//
// The three things the deadline sits beside are their own subjects and their own
// files: `frame-witness.test.ts` for the paint verdict, `bounded-cleanup.test.ts`
// for the close, and `launch-body.test.ts` for the allowance the caller's own
// body runs inside — the phase that used to be budgeted by nothing, whose
// allowance the tier timeouts below are now derived from.

import { globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ConsoleBudgetRegistry,
  ConsoleBudgetRegistryError,
} from "../../../scripts/budget/budget-registry.mjs";
import {
  BODY_ALLOWANCE_MS,
  CLEANUP_BUDGET_MS,
  ENDURANCE_BODY_ALLOWANCE_MS,
  FRAME_WITNESS_TIMEOUT_MS,
  READINESS_BUDGET_MS,
} from "../launch-budgets.js";
import {
  DeadlineExpiredError,
  LAUNCH_BUDGET_MS,
  LaunchDeadline,
  MINIMUM_SETTLEMENT_RESIDUAL_MS,
  POST_READINESS_RESERVE_MS,
  readinessFailure,
  tierTimeoutFor,
} from "../launch-deadline.js";
import { resolveVitestProjects, type ResolvedVitestProjects } from "../vitest-projects.js";
import { deferredRejection, expectNoUnhandledRejection } from "./deferred-rejection.js";

/** A budget short enough that exhausting it costs the suite nothing. */
const TEST_BUDGET_MS = 200;

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");

/**
 * Every test file that drives a real Electron window through `withLaunchedConsole`.
 *
 * A glob over the two directories rather than a list of project NAMES, so a tier
 * added later — or a file moved between them — is covered without anybody
 * remembering to widen this. The names those files resolve to are read off the
 * real config below.
 */
const ELECTRON_TIER_FILE_GLOB = "test/console/{e2e,endurance}/**/*.test.ts";

/**
 * The only patience figures a launching tier may carry.
 *
 * One per registered body allowance, each derived by the same arithmetic the
 * config calls. A tier whose timeout is not one of these is carrying a literal,
 * which is what the end-to-end tier's 60 000 ms was — a number under which the
 * launch, the body, and the cleanup did not fit.
 */
const DERIVED_TIER_TIMEOUTS_MS: readonly number[] = [
  tierTimeoutFor(BODY_ALLOWANCE_MS),
  tierTimeoutFor(ENDURANCE_BODY_ALLOWANCE_MS),
];

describe("launch budget — one launch always settles inside its tier", () => {
  let resolvedProjects: ResolvedVitestProjects;
  let electronTierFiles: readonly string[];
  let launchingTierNames: readonly string[];
  let launchingTiers: readonly { name: string; patienceMs: number }[];

  beforeAll(async () => {
    resolvedProjects = await resolveVitestProjects();
    electronTierFiles = globSync(ELECTRON_TIER_FILE_GLOB, { cwd: PACKAGE_ROOT }).sort();
    const owners = resolvedProjects.projects.filter((project) =>
      electronTierFiles.some((relativePath) =>
        project.matchesTestGlob(join(PACKAGE_ROOT, relativePath)),
      ),
    );
    launchingTierNames = owners.map((project) => project.name);
    launchingTiers = owners.map((project) => ({
      name: project.name,
      // The SMALLER of the two, because a launch happens inside whichever the
      // caller used — a test body in one tier, a `beforeAll` in another — and a
      // guarantee that holds for only one of them is not a guarantee.
      patienceMs: Math.min(project.config.testTimeout, project.config.hookTimeout),
    }));
  }, 60_000);

  afterAll(async () => {
    await resolvedProjects.close();
  });

  it("finds tiers to check, and does not find every tier", () => {
    // Both halves are load-bearing. Without the first, the per-tier assertion
    // below is vacuously true over an empty list — the shape a config that failed
    // to resolve, or a glob that matched nothing, would take. Without the second,
    // it would also pass over a `matchesTestGlob` that claimed everything, which
    // would quietly stop being a statement about the Electron tiers at all: this
    // very file belongs to `console-architecture`, which launches no window.
    expect(electronTierFiles.length).toBeGreaterThan(1);
    expect(launchingTierNames.length).toBeGreaterThan(1);
    expect(launchingTierNames).not.toContain("console-architecture");
  });

  it("fits a launch, a body, and cleanup inside every launching tier's real timeout", () => {
    // THE GUARANTEE, held against the config the runner actually resolves rather
    // than a number copied out of it. A launch spends at most `LAUNCH_BUDGET_MS`
    // before it has thrown its own diagnostic — cleanup included, since that is a
    // reserved slice and no longer an unbounded await — the body then spends at
    // most its allowance, and the residual covers the synchronous profile removal
    // and the throw. The body is the term this sum was missing: without it the
    // arithmetic closed while the tier it described did not, and the end-to-end
    // tier's 60 000 ms left a body with three 10 000 ms polls 5 000 ms to run in.
    // The DEFAULT allowance is used because it is what a tier that states none
    // applies; a tier that states a longer one is checked exactly against it by
    // the case below.
    const tooTight = launchingTiers.filter(
      (tier) =>
        LAUNCH_BUDGET_MS + BODY_ALLOWANCE_MS + MINIMUM_SETTLEMENT_RESIDUAL_MS > tier.patienceMs,
    );
    expect(tooTight).toStrictEqual([]);
  });

  it("derives every launching tier's patience rather than writing it down", () => {
    // A tier's timeout must BE one of the derived figures, not merely exceed the
    // sum: a literal that happens to be large enough is still a number nobody
    // re-derives when a bound moves, and the two rows this file reads are exactly
    // the two figures a launching tier may carry.
    const underived = launchingTiers.filter(
      (tier) => !DERIVED_TIER_TIMEOUTS_MS.includes(tier.patienceMs),
    );
    expect(underived).toStrictEqual([]);
  });

  it("negative control: the literal this config used to carry is not a derived figure", () => {
    // Without this the case above passes over a `DERIVED_TIER_TIMEOUTS_MS` that
    // happened to contain everything. Re-plant `testTimeout: 60_000` on the
    // end-to-end tier and the case above goes red, because 60 000 is the sum of
    // nothing here.
    expect(DERIVED_TIER_TIMEOUTS_MS).not.toContain(60_000);
    expect(tierTimeoutFor(BODY_ALLOWANCE_MS)).toBe(
      LAUNCH_BUDGET_MS + BODY_ALLOWANCE_MS + MINIMUM_SETTLEMENT_RESIDUAL_MS,
    );
  });
});

describe("launch deadline — one clock, drawn from", () => {
  /** A clock the test moves by hand, so the arithmetic is checked without waiting. */
  function stoppedClock(startMs: number): { advance: (byMs: number) => void; now: () => number } {
    let current = startMs;
    return {
      advance: (byMs: number) => {
        current += byMs;
      },
      now: () => current,
    };
  }

  it("hands each phase what is left, not what the last one got", () => {
    // The whole defect in one assertion: four phases used to receive the budget
    // each, and now they share it.
    const clock = stoppedClock(1_000);
    const deadline = new LaunchDeadline(30_000, clock.now);
    expect(deadline.remainingMs()).toBe(30_000);
    clock.advance(20_000);
    expect(deadline.remainingMs()).toBe(10_000);
    clock.advance(9_000);
    expect(deadline.remainingMs()).toBe(1_000);
  });

  it("never reports zero, which Playwright would read as no timeout at all", () => {
    // An exhausted deadline is the one moment the honest answer is unsafe:
    // `timeout: 0` turns an overrun into an unbounded wait — the exact failure
    // the deadline exists to remove. `expired()` is where the truth lives.
    const clock = stoppedClock(1_000);
    const deadline = new LaunchDeadline(5_000, clock.now);
    expect(deadline.expired()).toBe(false);
    clock.advance(500_000);
    expect(deadline.expired()).toBe(true);
    expect(deadline.remainingMs()).toBe(1);
  });

  it("reports readiness spent when ITS allowance is gone, not the launch's", () => {
    // The reserve is what separates the two questions, and conflating them was a
    // live defect: a ladder that used its full 30 000 ms still has the 25 000 ms
    // witness-and-cleanup reserve in front of it, so the unreserved question
    // answers "plenty of time" at exactly the moment readiness has none.
    const clock = stoppedClock(1_000);
    const deadline = new LaunchDeadline(LAUNCH_BUDGET_MS, clock.now);
    clock.advance(READINESS_BUDGET_MS);
    expect(deadline.expired(POST_READINESS_RESERVE_MS)).toBe(true);
    // Same instant, same object: the LAUNCH is not spent, and the reserve the
    // witness and cleanup are owed is intact. Both answers are correct; asking
    // the wrong one is what produced the wrong diagnostic.
    expect(deadline.expired()).toBe(false);
    expect(deadline.remainingMs()).toBe(POST_READINESS_RESERVE_MS);
  });

  it("words a readiness overrun as one, once readiness is out of time", () => {
    // The consumer of the predicate above, checked through its own seam rather
    // than by re-deriving it. Before the reserve was passed, this case returned
    // Playwright's own "Timeout 1ms exceeded" — a number that describes what was
    // LEFT of a shared budget and names neither the budget nor the phases sharing
    // it, which is the whole reason the wrapper exists.
    const clock = stoppedClock(1_000);
    const deadline = new LaunchDeadline(LAUNCH_BUDGET_MS, clock.now);
    const phaseTimeout = new Error("Timeout 1ms exceeded.");

    // Before the ladder's allowance is gone, a failure is its own: a missing
    // selector or a crashed process must not be blamed on a clock with time left.
    clock.advance(READINESS_BUDGET_MS - 1);
    expect(readinessFailure(deadline, phaseTimeout)).toBe(phaseTimeout);

    clock.advance(1);
    const worded = readinessFailure(deadline, phaseTimeout);
    expect(worded).not.toBe(phaseTimeout);
    expect(worded).toBeInstanceOf(Error);
    expect((worded as Error).message).toContain(String(READINESS_BUDGET_MS));
    // The original is kept rather than replaced — which phase ran out is still
    // the first thing a reader wants.
    expect((worded as Error).cause).toBe(phaseTimeout);
  });

  it("words its own expiry as the readiness budget even when the clock disagrees", async () => {
    // THE SIBLING OF `launch-body.test.ts`'s CLOCK-SKEW CASE, and the same defect: this
    // re-wording used to be decided by reading the clock a second time, and a
    // `setTimeout` and `Date.now()` are separate readings of one instant. Measured at a
    // 5 ms budget on the authoring machine, the timer fired with `Date.now()` still one
    // millisecond short in 55 of 4 000 firings — so about one launch overrun in seventy
    // reported in the raw phase's words instead of the readiness budget's.
    //
    // A STOPPED clock is that skew made deterministic. The deadline's OWN expiry is
    // recognised by identity here, so it can never be vetoed by a reading that says
    // there is time left.
    const frozen = stoppedClock(1_000);
    const deadline = new LaunchDeadline(LAUNCH_BUDGET_MS, frozen.now);
    const ownExpiry = await deadline
      .settleWithin(new Promise<never>(() => undefined), "a phase", LAUNCH_BUDGET_MS - 5)
      .catch((error: unknown) => error);
    expect(ownExpiry).toBeInstanceOf(DeadlineExpiredError);
    expect(deadline.expired(POST_READINESS_RESERVE_MS), "the frozen clock says time is left").toBe(
      false,
    );

    const worded = readinessFailure(deadline, ownExpiry);
    expect(worded).not.toBe(ownExpiry);
    expect((worded as Error).message).toContain(String(READINESS_BUDGET_MS));
    expect((worded as Error).cause).toBe(ownExpiry);
  });

  it("negative control: another deadline's expiry is not reworded as this one's", () => {
    // Identity rather than `instanceof`, and this is what it buys. A deadline nested
    // inside the work is a different subject with a more specific phase, and blaming
    // the outer budget for it would replace the sentence a reader actually needs.
    const outer = new LaunchDeadline(LAUNCH_BUDGET_MS, stoppedClock(1_000).now);
    const inner = new LaunchDeadline(LAUNCH_BUDGET_MS, stoppedClock(1_000).now);
    const innerExpiry = new DeadlineExpiredError(inner, "an inner phase", 5);
    expect(outer.raisedExpiry(innerExpiry)).toBe(false);
    expect(inner.raisedExpiry(innerExpiry)).toBe(true);
    expect(readinessFailure(outer, innerExpiry)).toBe(innerExpiry);
  });

  it("lets an operation that settles in time through untouched", () => {
    return expect(
      new LaunchDeadline(TEST_BUDGET_MS).settleWithin(Promise.resolve("visible"), "a phase"),
    ).resolves.toBe("visible");
  });

  it("rejects an operation that carries no timeout of its own, naming the phase", async () => {
    // `page.evaluate` is this case: no `timeout` option, unaffected by
    // Playwright's default, and pending forever against a wedged renderer.
    await expect(
      new LaunchDeadline(TEST_BUDGET_MS / 4).settleWithin(
        new Promise<string>(() => undefined),
        "the renderer visibility read",
      ),
    ).rejects.toThrow(/the renderer visibility read did not settle/u);
  });

  it("negative control: the same deadline that timed one out passes a faster one", async () => {
    // Without this the case above is ambiguous between "the deadline expired" and
    // "settleWithin rejects everything".
    const settled = await new LaunchDeadline(TEST_BUDGET_MS).settleWithin(
      new Promise<string>((resolveLate) => {
        setTimeout(() => {
          resolveLate("visible");
        }, TEST_BUDGET_MS / 4);
      }),
      "the renderer visibility read",
    );
    expect(settled).toBe("visible");
  });

  it("lets a genuine failure through rather than reporting it as an overrun", async () => {
    await expect(
      new LaunchDeadline(TEST_BUDGET_MS).settleWithin(
        Promise.reject(new Error("Target page, context or browser has been closed")),
        "the renderer visibility read",
      ),
    ).rejects.toThrow(/has been closed/u);
  });

  it("survives an abandoned operation rejecting after the deadline expired", async () => {
    // Same hazard the witness carries: the launch path closes the application
    // right after a failed phase, which rejects the round trip still outstanding.
    // Unhandled, that fails the tier on something other than the phase's verdict.
    const abandoned = deferredRejection();
    await expect(
      new LaunchDeadline(TEST_BUDGET_MS / 4).settleWithin(abandoned.promise, "a phase"),
    ).rejects.toThrow(/did not settle/u);
    // Asserted rather than waited out. This is what holds `settleWithin` to
    // racing both promises rather than merely bounding one: `Promise.race` calls
    // `then` on the loser, so it stays handled — abandon it outside a race and
    // this line fails.
    await expectNoUnhandledRejection(() => {
      abandoned.reject(new Error("Target page, context or browser has been closed"));
    });
  });
});

describe("launch budgets — the figures come from the registry, not from here", () => {
  // `budgets.json` is this package's one home for a budget and its unit factor,
  // and until now the launcher's three timing bounds were the exception: literals
  // in TypeScript, one directory away, gated by nothing. They are rows now, and
  // these cases are what makes that a fact rather than a convention — a literal
  // re-typed into `launch-budgets.ts` fails here rather than quietly winning.
  const registry = ConsoleBudgetRegistry.load();

  it.each([
    ["console-launch-readiness", READINESS_BUDGET_MS],
    ["console-launch-frame-witness", FRAME_WITNESS_TIMEOUT_MS],
    ["console-launch-cleanup", CLEANUP_BUDGET_MS],
    ["console-launch-body", BODY_ALLOWANCE_MS],
    ["console-endurance-body", ENDURANCE_BODY_ALLOWANCE_MS],
  ])("takes %s from the registry row of that id", (budgetId, constant) => {
    const budget = registry.requireBudget(budgetId);
    expect(budget.limit.canonicalValue).toBe(constant);
    // In milliseconds, not a unit that merely reduces to one: a row that arrived
    // as `20 MiB` would still satisfy the equality above after conversion.
    expect(budget.limit.canonicalUnit).toBe("ms");
    expect(budget.scope).toBe("harness");
  });

  it("reads the same rows the registry calls the harness's own", () => {
    // Non-vacuous in the other direction: a harness row nobody reads would be a
    // budget declared and unenforced, which is the shape this file exists to
    // refuse.
    expect(
      registry
        .harnessBudgets()
        .map((budget) => budget.id)
        .sort(),
    ).toStrictEqual(
      [
        "console-endurance-body",
        "console-launch-body",
        "console-launch-cleanup",
        "console-launch-frame-witness",
        "console-launch-readiness",
      ].sort(),
    );
  });

  it("refuses a missing row rather than falling back to a literal", () => {
    expect(() => registry.requireBudget("console-launch-nothing")).toThrow(
      ConsoleBudgetRegistryError,
    );
  });
});
