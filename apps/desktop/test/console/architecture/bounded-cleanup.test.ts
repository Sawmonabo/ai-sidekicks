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
// fixture makes a browser process refuse to close on demand, and no `rmSync` over
// a directory this process owns fails on a POSIX runner — which is exactly why
// both were cases nothing checked. So `BoundedCleanup` takes all three
// collaborators as constructor arguments — the application, the terminator, and
// the profile — and each of those cases is one object literal. The terminator
// seam is not merely a convenience: these cases run inside the runner, and a
// terminator that really killed something would deliver to a whole process group
// — the launched tree only because playwright-core spawns detached, and somebody
// else's for any other pid.
//
// What this file holds is the RACE — which settlement a close reaches, and
// whether the profile came off disk. What a caller is then TOLD about that
// verdict, and which of two failures a reader sees when the body failed too, is
// `cleanup-disposition.test.ts`: the two were one file until it passed 400 lines
// carrying both subjects, which is the split `frame-witness.test.ts` and
// `launch-deadline.test.ts` already made for the same reason.
//
// The launch clock these cases deliberately do NOT draw from is
// `launch-deadline.test.ts` — cleanup's bound is the registered ceiling rather
// than a slice of whatever is left; the verdict the witness renders just before
// them is `frame-witness.test.ts`.

import { describe, expect, it } from "vitest";

import {
  BoundedCleanup,
  type ClosableApplication,
  type ProcessTerminator,
} from "../bounded-cleanup.js";
import { withCleanupOutcome } from "../cleanup-disposition.js";
import { CLEANUP_BUDGET_MS } from "../launch-budgets.js";
import { type LaunchProfile } from "../launch-profile.js";
import { deferredRejection, expectNoUnhandledRejection } from "./deferred-rejection.js";

describe("bounded cleanup — a close that never settles", () => {
  /** A close bound short enough that exhausting it costs the suite nothing. */
  const TEST_BUDGET_MS = 120;

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

  /** The directory a spy profile claims, so a message that names one can be checked. */
  const TEST_PROFILE_DIRECTORY = "/tmp/ai-sidekicks-console-spy";

  /**
   * A profile that records the ATTEMPT rather than touching a disk — and refuses
   * it when the case is about a directory that will not go. Recording the attempt
   * rather than the success is what lets a case assert both halves: that the
   * removal was tried at all, and what came of it.
   */
  function profileSpy(refuseWith?: Error): LaunchProfile & { readonly removalAttempts: string[] } {
    const removalAttempts: string[] = [];
    return {
      directory: TEST_PROFILE_DIRECTORY,
      removalAttempts,
      remove: () => {
        removalAttempts.push(TEST_PROFILE_DIRECTORY);
        if (refuseWith !== undefined) {
          throw refuseWith;
        }
      },
    };
  }

  /** An application whose close rejects, with a pid the case decides the fate of. */
  function applicationWhoseCloseRejects(rejection: Error): ClosableApplication {
    return { close: () => Promise.reject(rejection), processId: () => 4242 };
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
      profileSpy(),
      TEST_BUDGET_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    expect(terminator.killed).toStrictEqual([4242]);
    // Settled BECAUSE of the bound, not before it and not far past it.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(TEST_BUDGET_MS * 0.9);
    expect(Date.now() - startedAt).toBeLessThan(TEST_BUDGET_MS * 10);
  });

  it("holds a launched console's close to the registered ceiling and nothing else", async () => {
    // THE CEILING FINDING. `budgets.json` declares `console-launch-cleanup` an enforced
    // `<= 10 000 ms` bound in a registry that models every row as a ceiling,
    // while the applied bound was `max(what the launch deadline has left, the
    // reserve)` — so a readiness failure two seconds in handed cleanup nearly
    // the whole 55 000 ms deadline and a budget audit read a constraint the
    // harness did not apply. The leftover launch time is not an input any more,
    // which is why the old behaviour cannot be constructed here at all: there is
    // no deadline to hand this class, and every launched console is held to the
    // row.
    const outcome = await new BoundedCleanup(
      { close: () => Promise.resolve(), processId: () => 4242 },
      terminatorSpy(true),
      profileSpy(),
    ).close();
    expect(outcome.budgetMs).toBe(CLEANUP_BUDGET_MS);
  });

  it("negative control: the reported bound is the one raced against, not the constant", async () => {
    // Without this the case above is ambiguous between "the ceiling is applied"
    // and "`budgetMs` is the constant restated". The cases here supply a bound
    // short enough to exhaust, and the verdict — and the sentence a reader sees
    // — carry THAT figure, so a message can never claim a process failed to
    // close in ten seconds when it was given a tenth of a second.
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminatorSpy(true),
      profileSpy(),
      TEST_BUDGET_MS,
    ).close();
    expect(outcome.budgetMs).toBe(TEST_BUDGET_MS);
    const worded = withCleanupOutcome(new Error("the launch failed"), outcome);
    expect((worded as Error).message).toContain(`${String(TEST_BUDGET_MS)} ms it was given`);
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
      profileSpy(),
      TEST_BUDGET_MS,
    ).close();
    expect(outcome.settlement).toBe("closed");
    expect(terminator.killed).toStrictEqual([]);
  });

  it("lets a close that takes time but lands inside the bound finish", async () => {
    // The regression the whole bound is shaped around, and the reason it is not
    // drawn from the launch deadline: `close()` is also called on the SUCCESS
    // path, minutes later for the endurance tier, when that deadline has nothing
    // left. A bound taken from it would be 1 ms there and would SIGKILL an
    // application that was closing perfectly normally. This close is slow and
    // fine, and survives.
    const terminator = terminatorSpy(true);
    const outcome = await new BoundedCleanup(
      {
        close: () =>
          new Promise<void>((resolveClose) => {
            setTimeout(resolveClose, TEST_BUDGET_MS * 0.5);
          }),
        processId: () => 4242,
      },
      terminator,
      profileSpy(),
      TEST_BUDGET_MS,
    ).close();
    expect(outcome.settlement).toBe("closed");
    expect(terminator.killed).toStrictEqual([]);
  });

  it("carries a profile it could not remove on the verdict, whatever the close settled", async () => {
    // THE REMOVAL FINDING. The removal used to sit at the caller in a `try`/`catch`
    // whose `catch` only called `console.error`, and a log line is not a failure
    // to vitest: a tier whose assertions passed stayed green with a per-launch
    // profile still on disk, and the run after it added another until the disk
    // failure that finally showed up looked like a console defect. The close here
    // is perfect and the removal is not, which is the pairing that shape could
    // not report at all.
    const profile = profileSpy(new Error("EBUSY: resource busy or locked"));
    const outcome = await new BoundedCleanup(
      { close: () => Promise.resolve(), processId: () => 4242 },
      terminatorSpy(true),
      profile,
    ).close();
    expect(profile.removalAttempts).toStrictEqual([TEST_PROFILE_DIRECTORY]);
    expect(outcome.settlement).toBe("closed");
    expect(outcome.profileRemovalFailure?.directory).toBe(TEST_PROFILE_DIRECTORY);
  });

  it("negative control: a removal that succeeds leaves the verdict carrying nothing", async () => {
    // Without this the case above is ambiguous between "the refusal was recorded"
    // and "the verdict always carries a removal failure". Same close, same
    // profile shape, one bit changed — and the removal still HAPPENED, which is
    // the other half a `catch` that only logged could hide.
    const profile = profileSpy();
    const outcome = await new BoundedCleanup(
      { close: () => Promise.resolve(), processId: () => 4242 },
      terminatorSpy(true),
      profile,
    ).close();
    expect(profile.removalAttempts).toStrictEqual([TEST_PROFILE_DIRECTORY]);
    expect(outcome.profileRemovalFailure).toBeUndefined();
  });

  it("removes the profile even when the close lost its race and was killed", async () => {
    // The path that MAKES a removal fail on Windows: the profile is removed with
    // the SIGKILL barely delivered. A removal skipped on the settlements that go
    // wrong would leak a directory exactly where a launch already went badly.
    const profile = profileSpy();
    const outcome = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminatorSpy(true),
      profile,
      TEST_BUDGET_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    expect(profile.removalAttempts).toStrictEqual([TEST_PROFILE_DIRECTORY]);
  });

  it("reports a hung close it cannot terminate, rather than claiming it killed one", async () => {
    // Two ways to get here — the process is already gone, or the signal did not
    // land — and both mean the same thing to a reader: something may still be
    // running and holding a profile, which is the one cleanup outcome that can
    // break a LATER launch. Folding it into `terminated` would hide exactly that.
    const withoutPid = await new BoundedCleanup(
      applicationThatNeverCloses(undefined),
      terminatorSpy(true),
      profileSpy(),
      TEST_BUDGET_MS,
    ).close();
    const refusedSignal = await new BoundedCleanup(
      applicationThatNeverCloses(4242),
      terminatorSpy(false),
      profileSpy(),
      TEST_BUDGET_MS,
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
      profileSpy(),
      TEST_BUDGET_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    expect(terminator.killed).toStrictEqual([4242]);
    // The rejection travels rather than being swallowed, so both callers can
    // surface what actually went wrong.
    expect(outcome.closeRejection).toBe(rejection);
    // Settled on the rejection, not by waiting the bound out: a close that has
    // stopped trying is not a hang.
    expect(outcome.waitedMs).toBeLessThan(TEST_BUDGET_MS);
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
      profileSpy(),
      TEST_BUDGET_MS,
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
              profileSpy(),
              TEST_BUDGET_MS,
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
    const abandonedClose = deferredRejection();
    const outcome = await new BoundedCleanup(
      { close: () => abandonedClose.promise, processId: () => 4242 },
      terminatorSpy(true),
      profileSpy(),
      TEST_BUDGET_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    // Asserted rather than waited out. This is what holds the cleanup to racing
    // the close rather than merely bounding it: `Promise.race` calls `then` on
    // the loser, so it stays handled — abandon it outside a race and this line
    // fails.
    await expectNoUnhandledRejection(() => {
      abandonedClose.reject(new Error("Target page, context or browser has been closed"));
    });
  });
});
