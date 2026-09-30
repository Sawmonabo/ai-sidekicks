// When the resource comes off disk, relative to the last termination attempt.
//
// `electron-child-profile-removal.test.ts` owns which paths reach a remover and
// `settle-time-disposal-bound.test.ts` owns how many times a refusing platform is asked. This owns
// the order between the two, which both could pass while a teardown removed the directory, then
// killed the tree.
//
// Vitest runs settle-time registrations in registration stack order, so a removal a caller
// registers after the spawn's own disposer would run first. Against a platform that refuses the
// kill, it would remove the profile under a live browser and then the spawn's disposer would make
// a further attempt. POSIX hides that because the unlink succeeds; on Windows the live handles
// make it fail and the locked profile outlives the run.
//
// So the claim is structural: exactly one settle-time disposer exists per spawned child, and the
// removal is the single act after its last attempt. A later attempt is impossible because there
// is no later disposer.
//
// The doubles are `electron-child-doubles.test-support.ts`'s, since no platform can be asked to
// refuse a kill on demand.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { disposeWhenTestFinishes, spawnManagedElectronChild } from "./electron-child.js";
import { DISPOSAL_ATTEMPTS } from "./managed-electron-child.js";
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
      // The terminator refuses every ask, so the child is still running at release, which is the
      // state in which a further attempt could follow. Equal ask counts at release and at the end
      // of the settlement mean nothing terminated after the removal.
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
        // The structural half: one disposer exists, so no kill can be held for after the release.
        expect(
          registrar.registeredCount,
          "a second settle-time disposer was armed for this child — the runner's stack order decides the teardown again",
        ).toBe(1);

        await registrar.settle();

        expect(
          trace.releases,
          "the release ran more than once, or not at all — it is no longer the single act after the last attempt",
        ).toBe(1);
        // Non-vacuity: the bound was spent, so the release is observed after a refusal.
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
      // Spawn, then register the removal separately. The runner settles in stack order, so this
      // removal runs first and the spawner's disposer terminates afterwards.
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
        // The leak, reproduced: terminations followed the removal.
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
