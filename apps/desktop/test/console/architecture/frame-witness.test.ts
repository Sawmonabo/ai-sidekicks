// The frame witness answers "is this renderer painting?" and not "is it fast?".
//
// Every Electron tier goes through `launchConsole`, and until this file existed
// the witness inside it had no test at all: the only way to exercise it was to
// launch a real window, which can only produce the PASSING case — no fixture can
// make a real Chromium stop painting on demand, and none can make it paint late
// on demand either. So the one behaviour that matters, the boundary between late
// and never, was the one behaviour nothing checked, and it was wrong: the bound
// was a fixed 2 000 ms from window creation, which two CI runs
// (33914273796 endurance, 33914986509 e2e) crossed on windows that were painting
// perfectly well.
//
// The seam is what makes this testable without an Electron process:
// `FrameWitness` takes its `RendererFrameSource` as a constructor argument, so a
// source that resolves late and a source that never resolves are each one object
// literal. The class under test is the REAL one the harness constructs — a local
// re-implementation of the race would pass while the shipped witness stayed
// broken.
//
// Every case runs against a small injected budget rather than the shipped
// `FRAME_WITNESS_TIMEOUT_MS`, and that is deliberate on two counts: the shipped
// value is a property of CI runners rather than of the race, and a suite that
// spent it would take 15 seconds to prove a timeout fires.
//
// THE OTHER HALF: THE BUDGET THE WITNESS SITS INSIDE
//
// A witness that renders a verdict its tier never waits to hear is no better
// than no witness. The readiness ladder ahead of it used to hand each of its
// four phases an independent 30 000 ms, so a launch was entitled to 135 000 ms
// inside a 60 000 ms tier: vitest would kill the test mid-phase and the reader
// would get "test timed out" instead of any of the sentences this file checks.
// `launch-deadline.ts` makes that one shared clock, and the last two blocks here
// hold its arithmetic against the REAL tier timeouts — resolved out of
// `vitest.config.ts` through `createVitest`, never copied into a literal that
// could drift away from the config while still agreeing with itself.

import { globSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FRAME_WITNESS_TIMEOUT_MS,
  FrameWitness,
  MEASURED_WORST_LOCAL_MS,
  type RendererFrameSource,
} from "../frame-witness.js";
import {
  BoundedCleanup,
  type ClosableApplication,
  type ProcessTerminator,
} from "../bounded-cleanup.js";
import {
  LAUNCH_BUDGET_MS,
  LaunchDeadline,
  MINIMUM_SETTLEMENT_RESIDUAL_MS,
  READINESS_BUDGET_MS,
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

/** A renderer that delivers its frames after `afterMs`, reporting `intervalMs`. */
function frameSourceDeliveringAfter(afterMs: number, intervalMs: number): RendererFrameSource {
  return {
    awaitTwoFrames: () =>
      new Promise<number>((resolveInterval) => {
        setTimeout(() => {
          resolveInterval(intervalMs);
        }, afterMs);
      }),
  };
}

/** A throttled renderer: the callbacks are registered and never run. */
function frameSourceThatNeverDelivers(): RendererFrameSource {
  return { awaitTwoFrames: () => new Promise<number>(() => undefined) };
}

describe("frame witness — late is not the same as never", () => {
  it("passes a renderer whose first frame is late but inside the budget", async () => {
    // The case both CI failures were: a window that painted, just not within the
    // window the old fused race allowed it.
    const outcome = await new FrameWitness(
      frameSourceDeliveringAfter(TEST_BUDGET_MS * 0.6, 97),
      TEST_BUDGET_MS,
    ).witness();
    expect(outcome.painting).toBe(true);
    // The reported interval is the RENDERER's figure, passed through untouched —
    // not the driver-side wall time, which is the other half of the diagnosis.
    expect(outcome).toMatchObject({ painting: true, frameIntervalMs: 97 });
  });

  it("fails a renderer whose frames never arrive", async () => {
    // The condition the witness exists for: background throttling left on, so
    // the callbacks are registered against a schedule that never runs.
    const outcome = await new FrameWitness(
      frameSourceThatNeverDelivers(),
      TEST_BUDGET_MS,
    ).witness();
    expect(outcome.painting).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_BUDGET_MS * 0.9);
  });

  it("negative control: the same budget that passed the late case fails a slower one", async () => {
    // Without this the case above is ambiguous between "the budget admitted a
    // late frame" and "the witness admits everything". Same witness, same
    // budget, one source moved past it.
    const budget = TEST_BUDGET_MS;
    const inside = await new FrameWitness(
      frameSourceDeliveringAfter(budget * 0.6, 12),
      budget,
    ).witness();
    const outside = await new FrameWitness(
      frameSourceDeliveringAfter(budget * 3, 12),
      budget,
    ).witness();
    expect([inside.painting, outside.painting]).toStrictEqual([true, false]);
  });

  it("lets a genuine renderer failure through rather than reporting it as unpainted", async () => {
    // A closed page or a crashed renderer rejects the probe. Reporting that as
    // "not painting" would send a reader to `window-reveal.ts` for a crash, so
    // the rejection propagates and the caller reports what actually happened.
    const crashed: RendererFrameSource = {
      awaitTwoFrames: () =>
        Promise.reject(new Error("Target page, context or browser has been closed")),
    };
    await expect(new FrameWitness(crashed, TEST_BUDGET_MS).witness()).rejects.toThrow(
      /has been closed/u,
    );
  });

  it("survives an abandoned probe rejecting after the budget expired", async () => {
    // The launch path closes the application right after a failed witness, which
    // rejects the probe that is still outstanding. Unhandled, that rejection
    // fails the whole tier on something other than the witness's own verdict —
    // so the outcome must settle AND the late rejection must reach a handler.
    let rejectAbandonedProbe: (reason: Error) => void = () => undefined;
    const abandoned: RendererFrameSource = {
      awaitTwoFrames: () =>
        new Promise<number>((_resolveInterval, reject) => {
          rejectAbandonedProbe = reject;
        }),
    };
    const outcome = await new FrameWitness(abandoned, TEST_BUDGET_MS).witness();
    expect(outcome.painting).toBe(false);
    rejectAbandonedProbe(new Error("Target page, context or browser has been closed"));
    // Give the rejection a turn to surface. If the witness had left it
    // unhandled, this is where the process would report it.
    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 10);
    });
  });
});

describe("frame witness — the shipped budget", () => {
  it("leaves the measured worst case at least two orders of magnitude of headroom", () => {
    // Not a re-statement of the constant: it holds the RELATIONSHIP the constant's
    // derivation claims, so shrinking the bound toward the measured figure — the
    // move that produced the flake this replaces — fails here and says why.
    expect(FRAME_WITNESS_TIMEOUT_MS).toBeGreaterThan(MEASURED_WORST_LOCAL_MS * 100);
  });

  it("stays inside half the cold-start budget it must not swallow", () => {
    // The ordering property the witness's derivation claims: readiness is the
    // longer wait, so a launch whose problem is the WINDOW runs out of readiness
    // first and fails naming the window rather than being reported as a renderer
    // that would not paint. Both constants are importable now that they live in
    // a module free of `@playwright/test`, so this is the real inequality rather
    // than the literal it used to restate against itself.
    expect(FRAME_WITNESS_TIMEOUT_MS).toBeLessThanOrEqual(READINESS_BUDGET_MS / 2);
  });
});

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

describe("bounded cleanup — a close that never settles", () => {
  /** A close bound short enough that exhausting it costs the suite nothing. */
  const TEST_RESERVE_MS = 120;

  /** An application whose close never settles, and whose process has a pid. */
  function applicationThatNeverCloses(processId: number | undefined): ClosableApplication {
    return { close: () => new Promise<void>(() => undefined), processId: () => processId };
  }

  /** A terminator that records rather than signals — killing for real would take this runner with it. */
  function terminatorSpy(delivers: boolean): ProcessTerminator & { readonly killed: number[] } {
    const killed: number[] = [];
    return {
      killed,
      terminate: (pid: number) => {
        killed.push(pid);
        return delivers;
      },
    };
  }

  /** A deadline with nothing left, which is what cleanup on the failure path meets. */
  function spentDeadline(): LaunchDeadline {
    const deadline = new LaunchDeadline(0);
    expect(deadline.expired()).toBe(true);
    return deadline;
  }

  it("settles inside the bound and SIGKILLs the process tree", async () => {
    // THE FINDING, in one case. Before this, close() was awaited with no bound at
    // all, so this application hung the launch until vitest killed the test — the
    // undiagnosable failure the whole change removes, one line further down than
    // where it was first removed.
    const terminator = terminatorSpy(true);
    const startedAt = Date.now();
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminator,
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    expect(terminator.killed).toStrictEqual([4242]);
    // Settled BECAUSE of the bound, not before it and not far past it.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_RESERVE_MS * 0.9);
    expect(Date.now() - startedAt).toBeLessThan(TEST_RESERVE_MS * 10);
  });

  it("negative control: a close that settles is neither bounded out nor killed", async () => {
    // Without this the case above is ambiguous between "the bound fired" and
    // "cleanup kills everything". Same bound, same terminator, one application
    // that closes.
    const terminator = terminatorSpy(true);
    const outcome = await new BoundedCleanup(
      { close: () => Promise.resolve(), processId: () => 4242 },
      terminator,
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    expect(outcome.settlement).toBe("closed");
    expect(terminator.killed).toStrictEqual([]);
  });

  it("gives a healthy close its full reserve even when the launch deadline is spent", async () => {
    // The regression this design is shaped around. `close()` is also called on
    // the SUCCESS path, minutes later for the endurance tier, when the launch
    // deadline has nothing left. A bound drawn from the deadline alone would be
    // 1 ms there and would SIGKILL an application that was closing perfectly
    // normally, so the reserve is a floor the deadline can only ever raise.
    const terminator = terminatorSpy(true);
    const outcome = await new BoundedCleanup(
      {
        close: () =>
          new Promise<void>((resolveClose) => {
            setTimeout(resolveClose, TEST_RESERVE_MS * 0.5);
          }),
        processId: () => 4242,
      },
      terminator,
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    expect(outcome.settlement).toBe("closed");
    expect(terminator.killed).toStrictEqual([]);
  });

  it("reports a hung close it cannot terminate, rather than claiming it killed one", async () => {
    // Two ways to get here — the process is already gone, or the signal did not
    // land — and both mean the same thing to a reader: something may still be
    // running and holding a profile, which is the one cleanup outcome that can
    // break a LATER launch. Folding it into `terminated` would hide exactly that.
    const withoutPid = await new BoundedCleanup(
      applicationThatNeverCloses(undefined),
      terminatorSpy(true),
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    const refusedSignal = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminatorSpy(false),
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    expect([withoutPid.settlement, refusedSignal.settlement]).toStrictEqual([
      "unterminable",
      "unterminable",
    ]);
  });

  it("treats a close that rejects as finished, not as a hang to wait out", async () => {
    // A rejected close has closed, unsuccessfully. Waiting out the bound and then
    // SIGKILLing would spend the slice on a process whose own failure already
    // reached it, and would name the wrong thing in the report.
    const terminator = terminatorSpy(true);
    const outcome = await new BoundedCleanup(
      {
        close: () => Promise.reject(new Error("Electron has already exited")),
        processId: () => 4242,
      },
      terminator,
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    expect(outcome.settlement).toBe("closed");
    expect(outcome.waitedMs).toBeLessThan(TEST_RESERVE_MS);
    expect(terminator.killed).toStrictEqual([]);
  });

  it("survives an abandoned close rejecting after the bound expired", async () => {
    // Killing the process is what MAKES the outstanding close reject, so this is
    // the ordinary path rather than an edge: unhandled, it would fail the tier on
    // something other than the failure that started the cleanup.
    let rejectAbandoned: (reason: Error) => void = () => undefined;
    const outcome = await new BoundedCleanup(
      {
        close: () =>
          new Promise<void>((_resolveNever, reject) => {
            rejectAbandoned = reject;
          }),
        processId: () => 4242,
      },
      terminatorSpy(true),
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    rejectAbandoned(new Error("Target page, context or browser has been closed"));
    await new Promise((resolveTick) => {
      setTimeout(resolveTick, 10);
    });
  });
});
