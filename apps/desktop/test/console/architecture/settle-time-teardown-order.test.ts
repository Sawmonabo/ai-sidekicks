// WHEN the resource comes off disk, relative to the LAST termination attempt.
//
// `electron-child-profile-removal.test.ts` beside this owns which paths reach a
// remover at all, and `settle-time-disposal-bound.test.ts` owns how many times a
// refusing platform is asked. This owns the ORDER between the two, which neither
// of them can state: both were satisfied by a teardown that removed the
// directory, then killed the tree, and reported nothing wrong.
//
// THE SHAPE THAT PRODUCED IT WAS THE RUNNER'S, NOT A HARNESS'S. The removal was
// a settle-time registration a caller made after the one `spawnManagedElectronChild`
// armed, and Vitest runs those in registration STACK order — so the caller's ran
// FIRST. Against a platform that refused the kill, that disposer spent its whole
// attempt bound on a child that was never going to close, removed the profile
// under a live browser, and only then did the spawn's own disposer take its turn:
// a FOURTH termination after the remover, with no removal anywhere behind it. On
// POSIX the unlink succeeds anyway and hides it; on Windows the live handles in
// the directory make it fail outright and the locked profile outlives the run.
//
// So the claim here is a structural one and it is asserted structurally: exactly
// ONE settle-time disposer exists per spawned child, and the removal is the
// single act after the last attempt that disposer makes. A later attempt is then
// impossible because there is no later disposer — not because a flag says so.
//
// The doubles are `electron-child-doubles.test-support.ts`'s, for that
// module's reason: no platform can be asked to refuse a kill on demand.

import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  disposeWhenTestFinishes,
  spawnManagedElectronChild,
} from "../../helpers/electron-child.js";
import { DISPOSAL_ATTEMPTS } from "../../helpers/managed-electron-child.js";
import {
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
} from "./electron-child-doubles.test-support.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  NON_TERMINATING_PROGRAM,
} from "./electron-child-lifetime.test-support.js";
import { reap } from "./electron-child-liveness.test-support.js";

/** What each refused attempt is given to produce a `close` that will not come. */
const REFUSED_KILL_SETTLE_WAIT_MS = 25;

/** More refusals than any bound here could spend, so the platform never relieves it. */
const REFUSALS_BEYOND_EVERY_BOUND = 99;

/** What one teardown did, in the order it did it. */
interface TeardownTrace {
  /** Terminator requests counted at the moment the release ran. */
  readonly asksBeforeRelease: number[];
  /** How many times the release ran. */
  releases: number;
}

describe("settle-time teardown — the release is the act after the LAST attempt", () => {
  it(
    "removes what the child held only after every termination attempt has settled",
    async () => {
      // THE FINDING. The terminator refuses every ask, so the loop spends its
      // whole bound and the child is still running when the release runs — which
      // is exactly the state in which a fourth attempt used to follow it. The
      // reading that catches that is the ask COUNT at release time compared with
      // the count when the settlement is over: equal means nothing terminated
      // after the removal.
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator(REFUSALS_BEYOND_EVERY_BOUND);
      const trace: TeardownTrace = { asksBeforeRelease: [], releases: 0 };
      const managed = spawnManagedElectronChild({
        command: process.execPath,
        args: ["-e", NON_TERMINATING_PROGRAM],
        cwd: process.cwd(),
        env: process.env,
        registerSettleTimeTermination: registrar.register,
        terminateProcessTree: terminator.terminate,
        releaseAfterTermination: () => {
          trace.releases += 1;
          trace.asksBeforeRelease.push(terminator.requests.length);
        },
        terminationExitWaitMs: REFUSED_KILL_SETTLE_WAIT_MS,
      });
      const childProcessId = managed.child.pid ?? 0;

      try {
        // The structural half, and the one that makes "impossible by
        // construction" a property rather than a promise: one disposer exists,
        // so there is nothing that could hold a kill for after the release.
        expect(
          registrar.registeredCount,
          "a second settle-time disposer was armed for this child — the runner's stack order decides the teardown again",
        ).toBe(1);

        await registrar.settle();

        expect(
          trace.releases,
          "the release ran more than once, or not at all — it is no longer the single act after the last attempt",
        ).toBe(1);
        // Non-vacuity: the bound really was spent, so the release is being
        // observed after a REFUSAL rather than after a kill that landed first.
        expect(terminator.requests.length).toBe(DISPOSAL_ATTEMPTS);
        expect(
          trace.asksBeforeRelease,
          "a termination attempt followed the release — on Windows that is the locked profile the teardown was supposed to take off disk",
        ).toStrictEqual([DISPOSAL_ATTEMPTS]);
      } finally {
        reap(childProcessId);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "negative control: registering the release separately puts a kill after it",
    async () => {
      // THE SUPERSEDED SHAPE, spelled as a caller used to spell it — spawn, then
      // register the removal — and driven through the same refusing platform.
      // The runner settles in registration STACK order, so this removal runs
      // first and the spawn door's own disposer terminates afterwards. Without
      // this the case above is ambiguous between "the order is owned" and "this
      // platform happened to stop asking".
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator(REFUSALS_BEYOND_EVERY_BOUND);
      const trace: TeardownTrace = { asksBeforeRelease: [], releases: 0 };
      const managed = spawnManagedElectronChild({
        command: process.execPath,
        args: ["-e", NON_TERMINATING_PROGRAM],
        cwd: process.cwd(),
        env: process.env,
        registerSettleTimeTermination: registrar.register,
        terminateProcessTree: terminator.terminate,
        terminationExitWaitMs: REFUSED_KILL_SETTLE_WAIT_MS,
      });
      const childProcessId = managed.child.pid ?? 0;
      disposeWhenTestFinishes(() => {
        trace.releases += 1;
        trace.asksBeforeRelease.push(terminator.requests.length);
      }, registrar.register);

      try {
        expect(registrar.registeredCount).toBe(2);

        await registrar.settle();

        expect(trace.releases).toBe(1);
        // The leak, reproduced: the release saw fewer asks than the settlement
        // finished with, so terminations followed the removal.
        expect(
          trace.asksBeforeRelease[0],
          "the control no longer reproduces the ordering leak — a second registration is not running before the spawn's own disposer",
        ).toBeLessThan(terminator.requests.length);
      } finally {
        reap(childProcessId);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});
