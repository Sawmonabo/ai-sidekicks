// Closing a launched console is a phase too, and it can hang like any other.
//
// Every phase of a launch drew from the shared deadline except the last one:
// `close()` awaited `application.close()` unbounded, so an Electron wedged rather
// than merely slow consumed whatever the tier had left and vitest's generic
// timeout won anyway — the same undiagnosable kill the deadline was introduced to
// remove, one line further down, with a temporary profile left on disk for the
// next launch to trip over.
//
// The behaviour that matters here is unreachable through a real Electron: no
// fixture makes a browser process refuse to close on demand, which is exactly why
// it was the case nothing checked. So `BoundedCleanup` takes both collaborators
// as constructor arguments — the application and the terminator — and a close
// that never settles is one object literal, while a terminator that RECORDS
// rather than signals is another. That second seam is not a convenience: these
// cases run inside the runner, and a terminator that really killed something
// would deliver to a whole process group — the launched tree only because
// playwright-core spawns detached, and somebody else's for any other pid.
//
// The clock these cases draw from is `launch-deadline.test.ts`; the verdict the
// witness renders just before them is `frame-witness.test.ts`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BoundedCleanup,
  CleanupFailedError,
  type CleanupOutcome,
  type ClosableApplication,
  type ProcessTerminator,
  cleanupFailure,
  withCleanupOutcome,
} from "../bounded-cleanup.js";
import { CLEANUP_BUDGET_MS } from "../launch-budgets.js";
import { LaunchDeadline } from "../launch-deadline.js";

describe("bounded cleanup — a close that never settles", () => {
  /** A close bound short enough that exhausting it costs the suite nothing. */
  const TEST_RESERVE_MS = 120;

  /** An application whose close never settles, and whose process has a pid. */
  function applicationThatNeverCloses(processId: number | undefined): ClosableApplication {
    return { close: () => new Promise<void>(() => undefined), processId: () => processId };
  }

  /**
   * A terminator that records rather than signals — killing for real would take
   * this runner with it — and answers liveness however the case needs.
   */
  function terminatorSpy(
    delivers: boolean,
    running = true,
  ): ProcessTerminator & { readonly killed: number[] } {
    const killed: number[] = [];
    return {
      killed,
      isRunning: () => running,
      terminate: (processId: number) => {
        killed.push(processId);
        return delivers;
      },
    };
  }

  /** An application whose close rejects, with a pid the case decides the fate of. */
  function applicationWhoseCloseRejects(rejection: Error): ClosableApplication {
    return { close: () => Promise.reject(rejection), processId: () => 4242 };
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

  it("reports the bound it was actually given, not the reserve", async () => {
    // A launch that fails EARLY leaves most of the deadline unspent, and the
    // applied bound is `max(remaining, reserve)` — so cleanup can be given far
    // more than `CLEANUP_BUDGET_MS`. Reporting the reserve there would claim a
    // process failed to close in ten seconds when it had been given five times
    // that: a diagnostic misdescribing its own measurement.
    const generous = TEST_RESERVE_MS * 4;
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminatorSpy(true),
      new LaunchDeadline(generous),
      TEST_RESERVE_MS,
    ).close();
    expect(outcome.budgetMs).toBeGreaterThanOrEqual(generous * 0.9);
    expect(outcome.budgetMs).toBeGreaterThan(TEST_RESERVE_MS);
    // And the sentence a reader sees carries that same figure rather than the
    // constant, so the two cannot disagree.
    const worded = withCleanupOutcome(new Error("the launch failed"), outcome);
    expect((worded as Error).message).toContain(String(outcome.budgetMs));
    expect((worded as Error).message).not.toContain(`${String(CLEANUP_BUDGET_MS)} ms it was given`);
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

  it("kills the process a rejected close left running, carrying the rejection", async () => {
    // THE FINDING. A rejected close used to be labelled `closed` outright: the
    // termination was skipped and the rejection discarded, so a tier could report
    // green with an Electron still holding its profile — and every Playwright
    // tier shares this harness, so the leak reaches the rest of the run.
    const rejection = new Error("Electron process failed to close");
    const terminator = terminatorSpy(true, true);
    const outcome = await new BoundedCleanup(
      applicationWhoseCloseRejects(rejection),
      terminator,
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    expect(terminator.killed).toStrictEqual([4242]);
    // The rejection travels rather than being swallowed, so both callers can
    // surface what actually went wrong.
    expect(outcome.closeRejection).toBe(rejection);
    // Settled on the rejection, not by waiting the bound out: a close that has
    // stopped trying is not a hang.
    expect(outcome.waitedMs).toBeLessThan(TEST_RESERVE_MS);
  });

  it("settles a rejected close whose process did exit as its own kind, still carrying it", async () => {
    // Nothing leaked and no kill was needed, so this is not `terminated`; but the
    // close DID fail, so it is not plain `closed` either — a caller told that
    // would have no way to surface the rejection, which is how it used to vanish.
    const rejection = new Error("Electron has already exited");
    const terminator = terminatorSpy(true, false);
    const outcome = await new BoundedCleanup(
      applicationWhoseCloseRejects(rejection),
      terminator,
      spentDeadline(),
      TEST_RESERVE_MS,
    ).close();
    expect(outcome.settlement).toBe("closed-after-rejection");
    expect(outcome.closeRejection).toBe(rejection);
    expect(terminator.killed).toStrictEqual([]);
  });

  it("negative control: the same rejection settles two ways on the liveness answer alone", async () => {
    // Without this, the pair above is ambiguous between "the probe decided" and
    // "the two cases differ for some other reason". One rejection, one spy shape,
    // one bit changed.
    const rejection = new Error("Electron process failed to close");
    const settlements = await Promise.all(
      [true, false].map(
        async (running) =>
          (
            await new BoundedCleanup(
              applicationWhoseCloseRejects(rejection),
              terminatorSpy(true, running),
              spentDeadline(),
              TEST_RESERVE_MS,
            ).close()
          ).settlement,
      ),
    );
    expect(settlements).toStrictEqual(["terminated", "closed-after-rejection"]);
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

describe("bounded cleanup — what a caller is told", () => {
  /** An outcome carrying whichever settlement a case is about. */
  function outcomeOf(settlement: CleanupOutcome["settlement"]): CleanupOutcome {
    return { settlement, waitedMs: 10_000, budgetMs: 10_000, processId: 4242 };
  }

  it("tells the caller nothing at all when the close was clean", () => {
    // The ordinary path. A sentence about cleanup on a run that cleaned up would
    // train a reader to skip the one that did not.
    expect(
      cleanupFailure({ settlement: "closed", waitedMs: 31, budgetMs: 10_000 }),
    ).toBeUndefined();
  });

  it.each(["unterminable", "closed-after-rejection"] as const)(
    "raises a failure the caller cannot ignore when the close settled %s",
    (settlement) => {
      // THE FINDING. Cleanup that went wrong was breadcrumbed with `console.error`
      // and the harness resolved anyway — and a log line is not a failure to
      // vitest, so a tier whose assertions passed reported success while leaving
      // an Electron alive for every launch after it. These are the two
      // settlements a LATER launch can feel: a process nothing could kill, and a
      // close that failed outright.
      const failure = cleanupFailure(outcomeOf(settlement));
      expect(failure).toBeInstanceOf(CleanupFailedError);
      expect(failure?.settlement).toBe(settlement);
      // Named, not merely counted: an operator told only that cleanup failed has
      // nothing to look for.
      expect(failure?.processId).toBe(4242);
      expect(failure?.message).toContain(settlement);
      expect(failure?.message).toContain("4242");
    },
  );

  it("lets a SIGKILLed tree pass, because the tree is gone", () => {
    // THE SECOND FINDING, and it is the mirror of the one above. `terminated`
    // says the close lost its race and the process tree was killed — which is
    // what `withCleanupOutcome` reports in the same breath as "later launches are
    // unaffected". Failing a tier over it would not catch a leak; it would catch
    // a healthy shutdown that ran long, which on the endurance tier is a close
    // bounded by the reserve alone after a full replay. The harness prints the
    // breadcrumb and the tier stays green.
    expect(cleanupFailure(outcomeOf("terminated"))).toBeUndefined();
    // Non-vacuous: the same outcome shape with the settlement that DOES reach a
    // later launch still raises, so this is the settlement deciding and not the
    // helper having stopped raising at all.
    expect(cleanupFailure(outcomeOf("unterminable"))).toBeInstanceOf(CleanupFailedError);
  });

  it("says so plainly when the process that would not close cannot be named", () => {
    // `processId()` answers `undefined` once Playwright has reaped the child, and
    // an error reading "pid undefined" is worse than one that admits it.
    // Built by hand: a default parameter would take `undefined` as "not supplied".
    const failure = cleanupFailure({ settlement: "unterminable", waitedMs: 10, budgetMs: 10_000 });
    expect(failure?.message).toContain("an unidentified process");
    expect(failure?.message).not.toContain("undefined");
  });

  it("warns about the profile lock only where a process may still hold it", () => {
    // `unterminable` is the settlement that breaks the NEXT launch —
    // `requestSingleInstanceLock()` is lost to a process nothing could kill — and
    // the one that earns the extra sentence. The other raising settlement, a
    // close that rejected while its process exited anyway, leaves nothing to
    // hold the lock and must not send a reader looking for one.
    expect(cleanupFailure(outcomeOf("unterminable"))?.message).toContain(
      "requestSingleInstanceLock",
    );
    expect(cleanupFailure(outcomeOf("closed-after-rejection"))?.message).not.toContain(
      "requestSingleInstanceLock",
    );
  });

  it("carries a rejected close as the cause rather than discarding it", () => {
    const rejection = new Error("Target page, context or browser has been closed");
    const failure = cleanupFailure({ ...outcomeOf("unterminable"), closeRejection: rejection });
    expect(failure?.cause).toBe(rejection);
  });

  it("keeps a launch failure on top and folds the cleanup into it", () => {
    // The launch-failure path. Two errors with the wrong one on top is how a
    // readiness timeout gets read as a cleanup defect, so there is one error: the
    // launch failure as `cause`, the cleanup as the sentence above it.
    const launchFailure = new Error("no animation frame arrived within 2000 ms");
    const folded = withCleanupOutcome(launchFailure, {
      ...outcomeOf("unterminable"),
      closeRejection: new Error("browser has been closed"),
    });
    expect(folded).toBeInstanceOf(Error);
    expect((folded as Error).cause).toBe(launchFailure);
    expect((folded as Error).message).toContain("close rejected: browser has been closed");
    expect((folded as Error).message).toContain("may still be running");
  });

  it("leaves a launch failure exactly as it was when the close was clean", () => {
    const launchFailure = new Error("no animation frame arrived within 2000 ms");
    expect(
      withCleanupOutcome(launchFailure, { settlement: "closed", waitedMs: 31, budgetMs: 10_000 }),
    ).toBe(launchFailure);
    // And when cleanup never ran at all, which is how the pre-readiness arms fail.
    expect(withCleanupOutcome(launchFailure, undefined)).toBe(launchFailure);
  });
});

describe("bounded cleanup — the harness spends both dispositions", () => {
  // The two call sites are inside a closure `launchConsole()` returns, reachable
  // only by launching a real Electron and then wedging it — which no fixture can
  // do. So the wiring is asserted against the source, the same instrument five
  // other tests in this tier already use for claims a running program cannot make
  // about itself. It is deliberately narrow: it checks that each disposition is
  // spent on its own path, not how the surrounding code reads.
  const harness = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "..", "electron-harness.ts"),
    "utf8",
  );

  it("throws the failure on the ordinary path", () => {
    // Not `console.error(...)` and fall through, which is what it used to do.
    expect(harness).toMatch(/const failure = cleanupFailure\(cleanupOutcome\);/);
    expect(harness).toMatch(/\n\s*throw failure;/);
  });

  it("breadcrumbs a wider set than it throws on", () => {
    // The two are separate statements because `terminated` reaches one and not
    // the other: a SIGKILLed tree is worth a line in a CI log and is not worth a
    // red check. A breadcrumb guarded by the failure instead would print nothing
    // for exactly the settlement whose figures a reader needs to re-derive the
    // bound from.
    expect(harness).toMatch(/if \(cleanupOutcome\.settlement !== "closed"\) \{\s*console\.error\(/);
  });

  it("swallows that throw on the launch-failure path and attaches the outcome", () => {
    // `close()` now rejects, and on this path that rejection must not win — the
    // launch failure is the error that explains the run.
    expect(harness).toMatch(/try \{\s*await close\(\);\s*\} catch \{/);
    expect(harness).toMatch(/throw withCleanupOutcome\(error, cleanupOutcome\);/);
  });
});
