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
// What this file holds is the RACE — which settlement a close reaches. What a
// caller is then TOLD about that settlement, and which of two failures a reader
// sees when the body failed too, is `cleanup-disposition.test.ts`: the two were
// one file until it passed 400 lines carrying both subjects, which is the split
// `frame-witness.test.ts` and `launch-deadline.test.ts` already made for the
// same reason.
//
// The clock these cases draw from is `launch-deadline.test.ts`; the verdict the
// witness renders just before them is `frame-witness.test.ts`.

import { describe, expect, it } from "vitest";

import {
  BoundedCleanup,
  type ClosableApplication,
  type ProcessTerminator,
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
