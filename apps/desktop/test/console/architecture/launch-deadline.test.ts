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
// The two things the deadline BOUNDS are their own subjects and their own files:
// `frame-witness.test.ts` for the paint verdict, `bounded-cleanup.test.ts` for
// the close.

import { globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  LAUNCH_BUDGET_MS,
  LaunchDeadline,
  MINIMUM_SETTLEMENT_RESIDUAL_MS,
} from "../launch-deadline.js";
import { resolveVitestProjects, type ResolvedVitestProjects } from "../vitest-projects.js";

/** A budget short enough that exhausting it costs the suite nothing. */
const TEST_BUDGET_MS = 200;

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "..", "..", "..");

/**
 * Every test file that drives a real Electron window through `launchConsole`.
 *
 * A glob over the two directories rather than a list of project NAMES, so a tier
 * added later — or a file moved between them — is covered without anybody
 * remembering to widen this. The names those files resolve to are read off the
 * real config below.
 */
const ELECTRON_TIER_FILE_GLOB = "test/console/{e2e,endurance}/**/*.test.ts";

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

  it("fits a whole launch plus cleanup inside every launching tier's real timeout", () => {
    // THE GUARANTEE, held against the config the runner actually resolves rather
    // than a number copied out of it. A launch spends at most `LAUNCH_BUDGET_MS`
    // before it has thrown its own diagnostic — cleanup included, since that is a
    // reserved slice and no longer an unbounded await — and the residual covers
    // the synchronous profile removal and the throw. Lower a tier's patience
    // below the sum and this fails here, at the arithmetic, instead of on a
    // runner as an undiagnosable kill.
    const tooTight = launchingTiers.filter(
      (tier) => LAUNCH_BUDGET_MS + MINIMUM_SETTLEMENT_RESIDUAL_MS > tier.patienceMs,
    );
    expect(tooTight).toStrictEqual([]);
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
    let rejectAbandoned: (reason: Error) => void = () => undefined;
    const abandoned = new Promise<string>((_resolveNever, reject) => {
      rejectAbandoned = reject;
    });
    await expect(
      new LaunchDeadline(TEST_BUDGET_MS / 4).settleWithin(abandoned, "a phase"),
    ).rejects.toThrow(/did not settle/u);
    rejectAbandoned(new Error("Target page, context or browser has been closed"));
    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 10);
    });
  });
});
