// The race in `BoundedCleanup`: which settlement a close reaches and whether the profile came off
// disk.
//
// A hung close, a rejected close and a failing removal cannot be produced with a real Electron, so
// each collaborator is a constructor argument and each case is one object literal. The terminator
// is a spy because a real one would signal a whole process group from inside the runner. How a
// verdict is worded and raised is `cleanup-disposition.test.ts`, the refused-kill retry is
// `bounded-cleanup-retry.test.ts`, and the stand-ins are in `bounded-cleanup.test-support.ts`.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { processHasTerminated } from "./process-tree/liveness.js";
import { HOST_QUERY_TIMEOUT_MS } from "./process-tree/readers.js";
import { BoundedCleanup } from "./bounded-cleanup.js";
import { ELECTRON_PROCESS_TERMINATOR } from "./cleanup-contract.js";
import { withCleanupOutcome } from "./cleanup-disposition.js";
import { CLEANUP_BUDGET_MS } from "./launch-budgets.js";
import {
  applicationThatNeverCloses,
  applicationWhoseCloseRejects,
  profileSpy,
  TEST_BUDGET_MS,
  TEST_PROFILE_DIRECTORY,
  TEST_TERMINATION_WAIT_MS,
  terminatorSpy,
} from "./bounded-cleanup.test-support.js";
import { deferredRejection, expectNoUnhandledRejection } from "./deferred-rejection.js";

describe("bounded cleanup — a close that never settles", () => {
  it("settles inside the bound and SIGKILLs the process tree", async () => {
    // Without a bound, a close that hangs holds the launch until vitest kills the test with no
    // diagnostic.
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
    // The applied bound is the registered ceiling, not what the launch deadline has left. The class
    // takes no deadline, so no launched console can be given more than the row.
    const outcome = await new BoundedCleanup(
      { close: () => Promise.resolve(), processId: () => 4242 },
      terminatorSpy(true),
      profileSpy(),
    ).close();
    expect(outcome.budgetMs).toBe(CLEANUP_BUDGET_MS);
  });

  it("negative control: the reported bound is the one raced against, not the constant", async () => {
    // Tells "the ceiling is applied" from "`budgetMs` is the constant restated": the message must
    // name the bound that was actually raced against.
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
    // Tells "the bound fired" from "cleanup kills everything": same bound and terminator, but the
    // application closes.
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
    // The bound is not drawn from the launch deadline because `close()` also runs on the success
    // path, long after that deadline; a slow but healthy close must survive.
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
    // A removal failure must travel on the verdict: a logged error is not a failure to vitest, so a
    // green tier would leave the profile on disk.
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
    // Same close with a working removal: the verdict carries nothing, and the removal still ran.
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
    // Skipping the removal on a bad settlement would leak a directory exactly where a launch
    // already went wrong.
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
    // A missing pid and a refused signal both leave something that may still hold a profile;
    // folding them into `terminated` would hide that.
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
      TEST_TERMINATION_WAIT_MS,
    ).close();
    expect([withoutPid.settlement, refusedSignal.settlement]).toStrictEqual([
      "unterminable",
      "unterminable",
    ]);
  });

  it("kills the process a rejected close left running, carrying the rejection", async () => {
    // A rejected close must not be reported as `closed`: that skipped termination and could leave
    // an Electron holding its profile.
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
    // The rejection travels on the outcome instead of being swallowed.
    expect(outcome.closeRejection).toBe(rejection);
    // Settled on the rejection, not by waiting out the bound.
    expect(outcome.waitedMs).toBeLessThan(TEST_BUDGET_MS);
  });

  it("settles a rejected close whose process did exit as its own kind, still carrying it", async () => {
    // The process exited so nothing leaked, but the close failed, so it is not plain `closed` and
    // the rejection must still reach the caller.
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
    // One rejection and one spy shape, differing only in the liveness answer.
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
    // Killing the process makes the outstanding close reject; unhandled, that would fail the tier
    // on the wrong error.
    const abandonedClose = deferredRejection();
    const outcome = await new BoundedCleanup(
      { close: () => abandonedClose.promise, processId: () => 4242 },
      terminatorSpy(true),
      profileSpy(),
      TEST_BUDGET_MS,
    ).close();
    expect(outcome.settlement).toBe("terminated");
    // Fails if the abandoned close is left outside the race: `Promise.race` keeps the loser
    // handled.
    await expectNoUnhandledRejection(() => {
      abandonedClose.reject(new Error("Target page, context or browser has been closed"));
    });
  });
});

describe("bounded cleanup — which liveness reading a verdict rests on", () => {
  // `processExists` is true for an exited, unreaped process, which is what a group SIGKILL leaves
  // every grandchild as. Verdicts must use the reading that counts it as gone, or they report
  // `unterminable` over a tree that is gone.

  it("binds the real terminator to the reading that counts a zombie as gone", () => {
    const reaped = spawnSync(process.execPath, ["-e", ""]);
    expect(reaped.pid).toBeGreaterThan(0);
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(process.pid, HOST_QUERY_TIMEOUT_MS)).toBe(true);
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(reaped.pid, HOST_QUERY_TIMEOUT_MS)).toBe(false);
    // Both pids agree under either reading; only an unreaped zombie separates them and its
    // lifetime depends on the host's init, so the binding is asserted as well.
    expect(ELECTRON_PROCESS_TERMINATOR.isRunning(process.pid, HOST_QUERY_TIMEOUT_MS)).toBe(
      !processHasTerminated(process.pid, HOST_QUERY_TIMEOUT_MS),
    );
  });
});
