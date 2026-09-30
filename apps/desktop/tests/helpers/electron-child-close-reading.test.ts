// What `close` means to a managed child, and the two decisions that rest on it.
//
// Both concern the window between `exit` and `close`, and after `close`:
//
//   1. Settle-time cleanup releases what the child held. Doing that on an exit code releases it
//      while a descendant that inherited the child's stdio may still hold files inside it; on
//      Windows the removal fails against the open handle and the directory outlives the run.
//   2. Disposal signals the child's tree. After `close` the pid is already reaped and may have
//      been reissued, and `smoke-probe-harness.ts` and `gc-probe-harness.ts` both call `dispose`
//      from the child's own `close` handler, so that is the ordinary path.
//
// The gap is produced, not simulated: the child hands its stdout to a grandchild and exits, like
// the launcher shim whose browser keeps the inherited write end, so `exit` has fired and
// `exitCode` is set while `close` has not. The gap is entered through `expectExitReported`, not
// the pid, because `expectTerminatedWithin` counts an unreaped zombie as gone and a case that
// waited on it reached its assertions with `exitCode` still `null`.
//
// Doubles are in `electron-child-doubles.test-support.ts`, child programs in
// `electron-child-lifetime.test-support.ts`, bounded readings in
// `electron-child-liveness.test-support.ts`.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readProcessLiveness } from "./process-tree/liveness.js";
import {
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
} from "./electron-child-doubles.test-support.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  spawnChildWithGrandchild,
} from "./electron-child-lifetime.test-support.js";
import {
  expectExitReported,
  expectTerminatedWithin,
  reap,
  TERMINATION_OBSERVATION_MS,
} from "./electron-child-liveness.test-support.js";

describe("a managed child is gone when it CLOSES, not when it reports an exit code", () => {
  it(
    "waits out the descendant that still holds the stdio before releasing the profile",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const profileDirectory = mkdtempSync(path.join(tmpdir(), "sidekicks-close-wait-"));
      let closedWhenRemoved: boolean | null = null;
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar, {
        exitHoldingStdio: true,
        releaseAfterTermination: () => {
          closedWhenRemoved = managed.hasClosed;
          rmSync(profileDirectory, { recursive: true, force: true });
        },
      });
      try {
        // Assert the gap first: the child has exited but `close` is undelivered because the
        // grandchild holds the pipe. Without both halves the case would pass over a child that had
        // simply closed.
        await expectExitReported(managed);
        expect(
          managed.hasClosed,
          "`close` was already delivered — the grandchild is not holding the stdio open and this proves nothing",
        ).toBe(false);
        expect(readProcessLiveness(grandchildPid)).toBe("running");

        expect(existsSync(profileDirectory)).toBe(true);

        await registrar.settle();

        // Fails if the wait is on `exitCode`, which is set before the disposer is registered.
        expect(
          closedWhenRemoved,
          "the profile was removed while a descendant still held the child's stdio open — the wait is back on an exit code",
        ).toBe(true);
        expect(existsSync(profileDirectory)).toBe(false);
        await expectTerminatedWithin(grandchildPid, "the grandchild the group kill was for");
      } finally {
        reap(grandchildPid);
        reap(childPid);
        rmSync(profileDirectory, { recursive: true, force: true });
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "asks for no kill once close has fired, because the pid is reapable by then",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator();
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar, {
        exitHoldingStdio: true,
        terminateProcessTree: terminator.terminate,
      });
      try {
        await expectExitReported(managed);
        // Through the real terminator, so the observed one records only what `dispose` asks of it.
        // Releasing the grandchild releases the inherited write end, which lets `close` arrive.
        reap(grandchildPid);
        await expect
          .poll(() => managed.hasClosed, {
            timeout: TERMINATION_OBSERVATION_MS,
            message: "`close` never arrived after the whole tree was gone",
          })
          .toBe(true);

        // Both pids are reaped, so any target a kill could name is the OS's to reissue;
        // `smoke-probe-harness.ts` makes this call from its `close` handler. Disposal before
        // `close` still signaling is covered in `electron-child-lifetime.test.ts`.
        managed.dispose();

        expect(
          terminator.requests,
          "a kill was addressed to a reaped pid, and its group — on POSIX either may already name something this test never started",
        ).toStrictEqual([]);
        expect(
          managed.directHandleReleased,
          "the abort fired on a child that had a pid, which is never this mechanism's answer",
        ).toBe(false);
        expect(managed.isKilled, "a kill nobody delivered was recorded as delivered").toBe(false);
      } finally {
        reap(grandchildPid);
        reap(childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});
