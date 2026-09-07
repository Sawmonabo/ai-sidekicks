// What `close` means to a managed child, and the two decisions that rest on it.
//
// Both are about the SAME window — between `exit` and `close`, and after
// `close` — and both were decided from `exitCode` before this suite existed,
// which is a different fact:
//
//   1. Settle-time cleanup releases what the child was holding. Doing that on
//      an exit code releases it while a descendant that inherited the child's
//      stdio is still running and may still hold files inside it. On POSIX the
//      unlink succeeds anyway and the bug is invisible; on Windows the removal
//      fails against the open handle and the directory outlives the run.
//   2. Disposal signals the child's tree. Doing that after `close` signals a
//      pid the operating system has already reaped and may already have
//      reissued — and `electron-probe.ts` and `lifecycle.gc.test.ts` both call
//      `dispose` from the child's own `close` handler, so this is the ordinary
//      path rather than a corner of one.
//
// THE GAP IS REAL AND IS PRODUCED, NOT SIMULATED. The child spawned here hands
// its stdout to a grandchild and then exits, which is the launcher shim one step
// smaller: `node_modules/.bin/electron` exits and the browser process it started
// keeps the inherited write end. So `exit` has fired and `exitCode` is set while
// `close` has not been delivered — the state a fake with a `kill` spy could
// assert about but not be wrong about.
//
// THE GAP IS ENTERED THROUGH `expectExitReported` AND NOT THROUGH THE PID. That
// distinction is measured rather than stylistic: `expectTerminatedWithin` counts
// an unreaped zombie as gone, so a case that waits on it reaches its assertions
// with `exitCode` still `null` — and the first version of this file did, which
// made its control pass against the very defect it was written for.
//
// The stand-ins are `electron-child-lifetime.test-support.ts`'s and the bounded
// readings are `electron-child-liveness.test-support.ts`'s; the claims are here.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { cleanUpAfterChildAtSettleTime } from "../../helpers/electron-child-cleanup.js";
import { readProcessLiveness } from "../../helpers/process-tree.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
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
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar, {
        exitHoldingStdio: true,
      });
      try {
        // THE GAP, ASSERTED BEFORE ANYTHING IS ASKED OF IT. The child is gone by
        // the reading the superseded cleanup returned on, and `close` has still
        // not been delivered because the grandchild holds the pipe. Without both
        // halves the case below would pass over a child that had simply closed,
        // which is the state that reading is right about.
        await expectExitReported(managed);
        expect(
          managed.hasClosed,
          "`close` was already delivered — the grandchild is not holding the stdio open and this proves nothing",
        ).toBe(false);
        expect(readProcessLiveness(grandchildPid)).toBe("running");

        let closedWhenRemoved: boolean | null = null;
        cleanUpAfterChildAtSettleTime(
          managed,
          () => {
            closedWhenRemoved = managed.hasClosed;
            rmSync(profileDirectory, { recursive: true, force: true });
          },
          registrar.register,
        );
        expect(existsSync(profileDirectory)).toBe(true);

        await registrar.settle();

        // The control the exit-code proxy fails: with `whenChildIsGone` deciding
        // on `exitCode`, this reads false, because the code was set before the
        // disposer was even registered.
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
        // Through the REAL terminator, so the observed one still records nothing
        // but what `dispose` asks of it. Releasing the grandchild releases the
        // inherited write end, which is what lets `close` be delivered at all.
        reap(grandchildPid);
        await expect
          .poll(() => managed.hasClosed, {
            timeout: TERMINATION_OBSERVATION_MS,
            message: "`close` never arrived after the whole tree was gone",
          })
          .toBe(true);

        // Both pids are now reaped, so every target a kill could name is the
        // operating system's to reissue. This is the call `electron-probe.ts`
        // makes from its own `close` handler.
        //
        // The other side of this rule — that a disposal BEFORE `close` still
        // signals the tree — is `electron-child-lifetime.test.ts`'s first case
        // and its refused-kill case, which run in this same tier. Restating it
        // here would be a second home for a claim that already has one.
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
