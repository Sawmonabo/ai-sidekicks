// One clock for a launch, and the arithmetic that keeps it inside its tier.
//
// A witness that renders a verdict its tier never waits to hear is no better than no witness, so
// the readiness ladder, the witness and the cleanup share one clock divided into three named
// slices (`launch-deadline.ts`). The arithmetic runs here against an injected clock, so nothing
// has to elapse. The tier timeouts a launch must fit inside are derived in
// `vitest/tier-projects.ts` through `tierTimeoutFor`.
//
// The neighboring subjects have their own files: `frame-paint-probe.test.ts` for the paint
// verdict, `bounded-cleanup.test.ts` for the close, and `launch-body.test.ts` for the allowance
// the caller's body runs inside.

import { describe, expect, it } from "vitest";

import { BudgetRegistry } from "../../scripts/budget/budget-registry.mjs";
import { BudgetRegistryError } from "../../scripts/budget/budget-document.mjs";
import {
  BODY_ALLOWANCE_MS,
  CLEANUP_BUDGET_MS,
  ENDURANCE_BODY_ALLOWANCE_MS,
  FRAME_PAINT_PROBE_TIMEOUT_MS,
  READINESS_BUDGET_MS,
} from "./launch-budgets.js";
import {
  DeadlineExpiredError,
  LAUNCH_BUDGET_MS,
  LaunchDeadline,
  POST_READINESS_RESERVE_MS,
  readinessFailure,
} from "./launch-deadline.js";
import { deferredRejection, expectNoUnhandledRejection } from "./deferred-rejection.js";

/** A budget short enough that exhausting it costs the suite nothing. */
const TEST_BUDGET_MS = 200;

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
    // Phases share the budget instead of each receiving it.
    const clock = stoppedClock(1_000);
    const deadline = new LaunchDeadline(30_000, clock.now);
    expect(deadline.remainingMs()).toBe(30_000);
    clock.advance(20_000);
    expect(deadline.remainingMs()).toBe(10_000);
    clock.advance(9_000);
    expect(deadline.remainingMs()).toBe(1_000);
  });

  it("never reports zero, which Playwright would read as no timeout at all", () => {
    // On an exhausted deadline `timeout: 0` would turn an overrun into an unbounded wait, so
    // `remainingMs` is floored at 1 and `expired()` is where the truth lives.
    const clock = stoppedClock(1_000);
    const deadline = new LaunchDeadline(5_000, clock.now);
    expect(deadline.expired()).toBe(false);
    clock.advance(500_000);
    expect(deadline.expired()).toBe(true);
    expect(deadline.remainingMs()).toBe(1);
  });

  it("reports readiness spent when ITS allowance is gone, not the launch's", () => {
    // The reserve separates the two questions: a ladder that used its full readiness allowance
    // still has the whole witness-and-cleanup reserve ahead of it, so the unreserved question
    // answers "plenty of time" exactly when readiness has none.
    const clock = stoppedClock(1_000);
    const deadline = new LaunchDeadline(LAUNCH_BUDGET_MS, clock.now);
    clock.advance(READINESS_BUDGET_MS);
    expect(deadline.expired(POST_READINESS_RESERVE_MS)).toBe(true);
    // Same instant, same object: the launch is not spent and the reserve owed to the witness and
    // cleanup is intact. Both answers are correct; asking the wrong one gives the wrong diagnostic.
    expect(deadline.expired()).toBe(false);
    expect(deadline.remainingMs()).toBe(POST_READINESS_RESERVE_MS);
  });

  it("words a readiness overrun as one, once readiness is out of time", () => {
    // The consumer of the predicate above, checked through its own seam. Without the reserve this
    // returned Playwright's "Timeout 1ms exceeded", which names neither the shared budget nor the
    // phases sharing it.
    const clock = stoppedClock(1_000);
    const deadline = new LaunchDeadline(LAUNCH_BUDGET_MS, clock.now);
    const phaseTimeout = new Error("Timeout 1ms exceeded.");

    // Before the ladder's allowance is gone a failure is its own: a missing selector or a crashed
    // process must not be blamed on a clock with time left.
    clock.advance(READINESS_BUDGET_MS - 1);
    expect(readinessFailure(deadline, phaseTimeout)).toBe(phaseTimeout);

    clock.advance(1);
    const worded = readinessFailure(deadline, phaseTimeout);
    expect(worded).not.toBe(phaseTimeout);
    expect(worded).toBeInstanceOf(Error);
    expect((worded as Error).message).toContain(String(READINESS_BUDGET_MS));
    // The original is kept: which phase ran out is still the first thing a reader wants.
    expect((worded as Error).cause).toBe(phaseTimeout);
  });

  it("words its own expiry as the readiness budget even when the clock disagrees", async () => {
    // The sibling of `launch-body.test.ts`'s clock-skew case: a `setTimeout` and `Date.now()` are
    // separate readings of one instant. Measured at a 5 ms budget, the timer fired with
    // `Date.now()` one millisecond short in 55 of 4 000 firings. A stopped clock makes that skew
    // deterministic; the deadline's own expiry is recognized by identity, so a reading that says
    // time is left cannot veto it.
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
    // Identity rather than `instanceof`: a nested deadline is a different subject with a more
    // specific phase, and blaming the outer budget would replace the sentence a reader needs.
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
    // `page.evaluate` is this case: no `timeout` option, and pending forever against a wedged
    // renderer.
    await expect(
      new LaunchDeadline(TEST_BUDGET_MS / 4).settleWithin(
        new Promise<string>(() => undefined),
        "the renderer visibility read",
      ),
    ).rejects.toThrow(/the renderer visibility read did not settle/u);
  });

  it("negative control: the same deadline that timed one out passes a faster one", async () => {
    // Guards the case above against `settleWithin` rejecting everything.
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
    // The launch path closes the application right after a failed phase, rejecting the round trip
    // still outstanding; unhandled, that fails the tier on something other than the phase's
    // verdict.
    const abandoned = deferredRejection();
    await expect(
      new LaunchDeadline(TEST_BUDGET_MS / 4).settleWithin(abandoned.promise, "a phase"),
    ).rejects.toThrow(/did not settle/u);
    // Holds `settleWithin` to racing both promises: `Promise.race` keeps the loser handled, so an
    // abandoned operation outside a race would fail this line.
    await expectNoUnhandledRejection(() => {
      abandoned.reject(new Error("Target page, context or browser has been closed"));
    });
  });
});

describe("launch budgets — the figures come from the registry, not from here", () => {
  // `budgets.json` is the one home for a budget; a literal re-typed into `launch-budgets.ts`
  // fails here instead of quietly winning.
  const registry = BudgetRegistry.load();

  it.each([
    ["console-launch-readiness", READINESS_BUDGET_MS],
    ["console-launch-frame-paint-probe", FRAME_PAINT_PROBE_TIMEOUT_MS],
    ["console-launch-cleanup", CLEANUP_BUDGET_MS],
    ["console-launch-body", BODY_ALLOWANCE_MS],
    ["console-endurance-body", ENDURANCE_BODY_ALLOWANCE_MS],
  ])("takes %s from the registry row of that id", (budgetId, constant) => {
    const budget = registry.requireBudget(budgetId);
    expect(budget.limit.canonicalValue).toBe(constant);
    // In milliseconds, not a unit that reduces to one: a row in `20 MiB` would pass the line above.
    expect(budget.limit.canonicalUnit).toBe("ms");
    expect(budget.scope).toBe("harness");
  });

  it("refuses a missing row rather than falling back to a literal", () => {
    expect(() => registry.requireBudget("console-launch-nothing")).toThrow(BudgetRegistryError);
  });
});
