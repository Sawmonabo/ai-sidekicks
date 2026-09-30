// How many times a settling test asks a refusing platform to kill its child.
//
// `electron-child-profile-removal.test.ts` owns the ordering (the profile comes off disk only once
// the child has closed). This owns the count, which that file cannot state: its refusal case
// spends two refusals and then lets the real terminator through.
//
// The settle-time disposal must not loop `DISPOSAL_ATTEMPTS` times around a call that itself loops
// that many times: a tree refusing every ask would be asked nine times, and on Windows each is a
// `taskkill` process spawned at a tree that already refused. Exactly one layer owns the count.
//
// The doubles are `electron-child-doubles.test-support.ts`'s, since no platform can be asked to
// refuse a kill on demand. The child is real, because the loop reads `hasClosed` off a real
// handle, and it is reaped in `finally`.

import process from "node:process";

import { describe, expect, it } from "vitest";

import { spawnManagedElectronChild } from "./electron-child.js";
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

/**
 * What each refused attempt is given to produce a `close` that will not come.
 *
 * Short and injected, because every attempt against a permanently refusing platform spends this
 * bound in full.
 */
const REFUSED_KILL_SETTLE_WAIT_MS = 50;

/**
 * More refusals than any bound under test could spend.
 *
 * `ObservedTreeTerminator` delegates to the real terminator once its refusals run out, and a case
 * measuring a ceiling must not have the platform relieve it partway through.
 */
const REFUSALS_BEYOND_EVERY_BOUND = 99;

describe("settle-time disposal — one layer owns the attempt count", () => {
  it(
    "asks a permanently refusing platform exactly the declared number of times",
    async () => {
      // Every ask reaches the terminator, so `requests.length` is the bound this path spends; nine
      // would be nested loops multiplying, and fewer than `DISPOSAL_ATTEMPTS` would be a retry that
      // stopped early. One registrar is the shape: the spawner arms the only settle-time disposer a
      // child has, so settling it settles the whole teardown.
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator(REFUSALS_BEYOND_EVERY_BOUND);
      let removals = 0;
      const managed = spawnManagedElectronChild({
        command: process.execPath,
        args: ["-e", NON_TERMINATING_PROGRAM],
        cwd: process.cwd(),
        env: process.env,
        registerSettleTimeTermination: registrar.register,
        terminateProcessTree: terminator.terminate,
        releaseAfterTermination: () => {
          removals += 1;
        },
        terminationExitWaitMs: REFUSED_KILL_SETTLE_WAIT_MS,
      });
      const childProcessId = managed.child.pid ?? 0;

      try {
        await registrar.settle();

        expect(
          terminator.requests.length,
          "the disposal loops multiplied — the declared bound is being spent once per layer rather than once in total",
        ).toBe(DISPOSAL_ATTEMPTS);
        // Non-vacuity: every ask was a SIGKILL at this child's own tree, and the release ran once,
        // so the bound was spent rather than returned from early.
        expect(terminator.requests.map((request) => request.signal)).toStrictEqual(
          Array.from({ length: DISPOSAL_ATTEMPTS }, () => "SIGKILL"),
        );
        expect(new Set(terminator.requests.map((request) => request.processId))).toStrictEqual(
          new Set([childProcessId]),
        );
        expect(removals).toBe(1);
      } finally {
        reap(childProcessId);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "negative control: a platform that kills what it is asked to kill is asked once",
    async () => {
      // Without this the case above cannot tell "the loop spends its bound on a refusal" from "it
      // always spends its bound", which would put three kills on every ordinary teardown.
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator();
      const managed = spawnManagedElectronChild({
        command: process.execPath,
        args: ["-e", NON_TERMINATING_PROGRAM],
        cwd: process.cwd(),
        env: process.env,
        registerSettleTimeTermination: registrar.register,
        terminateProcessTree: terminator.terminate,
        releaseAfterTermination: () => undefined,
        terminationExitWaitMs: REFUSED_KILL_SETTLE_WAIT_MS,
      });
      const childProcessId = managed.child.pid ?? 0;

      try {
        await registrar.settle();

        expect(
          terminator.requests.length,
          "an ordinary teardown spent more than one ask — the retry is running on a kill that landed",
        ).toBe(1);
      } finally {
        reap(childProcessId);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});
