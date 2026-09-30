// What a spawned child was holding, and which paths actually release it.
//
// Its lifetime is `electron-child-lifetime.test.ts` and what `close` means to it is
// `electron-child-close-reading.test.ts`. This file asks what survives both being right: the
// child is dead and its temporary Chromium profile is still on disk, because the code that would
// remove it hangs off an event the outcome never delivered.
//
// A harness removes its `--user-data-dir` from the child's `close` handler on a pass. A vitest
// timeout takes no such path: the worker is torn down with the test and the handler never runs.
// `spawnManagedElectronChild` binds the kill to the test; what binds the removal is
// `releaseAfterTermination`, run after the last attempt. Both Electron spawners pass one through
// `spawnChildCleanedUpAtSettleTime` (`smoke-probe-harness.ts`, `gc-probe-harness.ts`).
//
// On an ordinary run the `close` handler and the settle-time path reach the same remover, so the
// second call must be a no-op, which `rmSync`'s `force` gives and one case drives directly. One
// remover is not enough if the kill was refused: a separate settle-time removal would run first
// (stack order) and remove the directory under the live tree. One spawn argument and one disposer
// close that; the refusal case makes retry-then-remove a property, with the refusal injected
// because a `taskkill` that exits non-zero and leaves Electron running cannot be requested from a
// platform.
//
// Doubles are in `electron-child-doubles.test-support.ts`, child programs in
// `electron-child-lifetime.test-support.ts`, bounded readings in
// `electron-child-liveness.test-support.ts`.

import { existsSync, rmSync } from "node:fs";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { spawnManagedElectronChild, type ChildRelease } from "./electron-child.js";
import type { ManagedElectronChild, ProcessTreeTerminator } from "./managed-electron-child.js";
import { readProcessLiveness } from "./process-tree/liveness.js";
import {
  heldProfile,
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
} from "./electron-child-doubles.test-support.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  NON_TERMINATING_PROGRAM,
} from "./electron-child-lifetime.test-support.js";
import { expectTerminatedWithin, reap } from "./electron-child-liveness.test-support.js";

/**
 * What the refusal case gives each disposal attempt to produce a `close`.
 *
 * Shorter than the production grace and injected: every refused attempt spends it in full against
 * a child that will not close. Still generous for the attempt that lands, a group SIGKILL and the
 * stdio release behind `close`.
 */
const REFUSED_KILL_SETTLE_WAIT_MS = 1_000;

/**
 * More refusals than the shared attempt bound can spend.
 *
 * The negative control needs the child still running when the settlement ends; a platform that
 * relented partway would deliver the `close` the control does without. The case reaps the child
 * itself.
 */
const REFUSALS_BEYOND_EVERY_BOUND = 99;

/**
 * A child that will not exit on its own, spawned through the real chokepoint.
 *
 * The terminator is optional because only the refusal cases need one.
 */
function spawnHoldingChild(
  registrar: RecordingSettleRegistrar,
  releaseAfterTermination?: ChildRelease,
  terminateProcessTree?: ProcessTreeTerminator,
  terminationExitWaitMs?: number,
): ManagedElectronChild {
  return spawnManagedElectronChild({
    command: process.execPath,
    args: ["-e", NON_TERMINATING_PROGRAM],
    cwd: process.cwd(),
    env: process.env,
    registerSettleTimeTermination: registrar.register,
    terminateProcessTree,
    releaseAfterTermination,
    terminationExitWaitMs,
  });
}

describe("a settling test releases what its child was holding", () => {
  it(
    "removes what the child was holding, on the path no terminal event reaches",
    async () => {
      // The profile in the state a vitest timeout leaves it: the child is alive, so its `close`
      // has not fired and never will. Removal reachable only from there never happens on the
      // outcome that most needs it.
      const registrar = new RecordingSettleRegistrar();
      const profile = heldProfile();
      let closedWhenRemoved: boolean | null = null;
      const managed: ManagedElectronChild = spawnHoldingChild(registrar, () => {
        closedWhenRemoved = managed.hasClosed;
        profile.removeProfileDirectory();
      });
      const childPid = managed.child.pid ?? 0;

      // Whether the child had closed when the removal ran is the other half of the fix. On POSIX
      // a removal during exit succeeds anyway, so "the directory is gone" is true of a disposer
      // that never waited; on Windows it fails against live handles. The event is the reading, not
      // OS liveness, which is already terminated microseconds after the SIGKILL and answers the
      // same for both orderings. It is read off the managed child, which records the delivery from
      // its constructor: already true for a disposer that waited, false for one that removed in
      // the same turn as the kill.
      try {
        // Non-vacuity: the directory exists and the child runs, so the assertion after the
        // settlement is about the settlement.
        expect(existsSync(profile.directory)).toBe(true);
        expect(readProcessLiveness(childPid)).toBe("running");

        await registrar.settle();

        await expectTerminatedWithin(childPid, "the child holding the profile");
        expect(
          existsSync(profile.directory),
          "the profile outlived the test — removal is still reachable only from the child's own `close`",
        ).toBe(false);
        expect(
          closedWhenRemoved,
          "the profile was removed in the same turn as the kill — the disposer no longer waits for the child to be gone",
        ).toBe(true);
      } finally {
        reap(childPid);
        rmSync(profile.directory, { recursive: true, force: true });
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "runs the one remover from both paths on an ordinary run, and the second is a no-op",
    async () => {
      // The GC probe's shape, also the smoke probe's: a `close` handler that settles the harness
      // and removes the directory, plus the settle-time registration for outcomes that handler
      // never sees. Both reach the remover on an ordinary run, so a remover callable once would
      // turn a pass into a teardown failure. Driven because idempotence is a property of
      // `rmSync`'s `force` flag that a rewrite could drop silently.
      const registrar = new RecordingSettleRegistrar();
      const profile = heldProfile();
      const managed = spawnHoldingChild(registrar, profile.removeProfileDirectory);
      const childPid = managed.child.pid ?? 0;

      managed.child.once("close", () => {
        managed.dispose();
        profile.removeProfileDirectory();
      });

      try {
        expect(profile.removalCount()).toBe(0);
        expect(existsSync(profile.directory)).toBe(true);

        await registrar.settle();

        expect(
          profile.removalCount(),
          "only one path reached the remover — the two are not both wired to the same function",
        ).toBe(2);
        expect(existsSync(profile.directory)).toBe(false);
        // A further call on an already removed directory neither throws nor reports a failure;
        // asked of the real remover.
        expect(() => {
          profile.removeProfileDirectory();
        }).not.toThrow();
      } finally {
        reap(childPid);
        rmSync(profile.directory, { recursive: true, force: true });
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "retries a refused kill, and removes the profile only once the child has closed",
    async () => {
      // The ordering case. `dispose` signals without waiting, and a tree that refused the kill is
      // still there when the bounded wait runs out, so a disposer that removed the profile then
      // would do so under a live browser (on Windows the removal fails and the directory outlives
      // the run). Two refusals, not one, so the claim does not rest on which disposer consumes the
      // first; once spent, the stand-in delegates to the real terminator and nothing is left
      // running.
      const registrar = new RecordingSettleRegistrar();
      const profile = heldProfile();
      const terminator = new ObservedTreeTerminator(2);
      let closedWhenRemoved: boolean | null = null;
      const managed: ManagedElectronChild = spawnHoldingChild(
        registrar,
        () => {
          closedWhenRemoved = managed.hasClosed;
          profile.removeProfileDirectory();
        },
        terminator.terminate,
        REFUSED_KILL_SETTLE_WAIT_MS,
      );
      const childPid = managed.child.pid ?? 0;

      try {
        expect(existsSync(profile.directory)).toBe(true);
        expect(readProcessLiveness(childPid)).toBe("running");

        await registrar.settle();

        // The ordering claim first, then the termination reading: the retry has already waited
        // for `close`, so a rewrite that stops retrying should report the ordering it broke, not
        // the survivor that follows.
        expect(
          closedWhenRemoved,
          "the profile was removed while a refused kill still had the child alive — the disposal is not retried before the removal",
        ).toBe(true);
        expect(
          profile.removalCount(),
          "the retry reached the remover more than once — the removal is no longer the single act after the last wait",
        ).toBe(1);
        expect(existsSync(profile.directory)).toBe(false);
        // Non-vacuity, and what separates a retry from a late first ask: three SIGKILLs reached
        // the terminator, so both refusals were consumed and the third was a retry.
        expect(
          terminator.requests.map((request) => request.signal),
          "the terminator was asked fewer than three times — a refused kill was never retried",
        ).toStrictEqual(["SIGKILL", "SIGKILL", "SIGKILL"]);
        await expectTerminatedWithin(childPid, "the child whose first kills were refused");
      } finally {
        reap(childPid);
        rmSync(profile.directory, { recursive: true, force: true });
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "negative control: with only the close handler wired, the profile survives the settlement",
    async () => {
      // The remover is reachable only from the child's own `close`, which is later than the
      // settlement that kills it, and on a vitest timeout never arrives because the worker holding
      // the listener is torn down. The reading at settlement completion is what a torn-down worker
      // freezes.
      const registrar = new RecordingSettleRegistrar();
      const profile = heldProfile();
      // A platform that refuses every ask, so `close` is genuinely undelivered when the settlement
      // ends. Otherwise the settlement's own bounded wait for `close` would deliver it and the
      // handler would remove the directory.
      const terminator = new ObservedTreeTerminator(REFUSALS_BEYOND_EVERY_BOUND);
      const managed = spawnHoldingChild(
        registrar,
        undefined,
        terminator.terminate,
        REFUSED_KILL_SETTLE_WAIT_MS,
      );
      const childPid = managed.child.pid ?? 0;

      managed.child.once("close", () => {
        profile.removeProfileDirectory();
      });

      try {
        expect(existsSync(profile.directory)).toBe(true);

        await registrar.settle();

        // Non-vacuity: had `close` been delivered, the directory would be gone for a reason
        // unrelated to the missing registration.
        expect(
          managed.hasClosed,
          "`close` arrived inside the settlement, so this control is no longer standing in for a torn-down worker",
        ).toBe(false);
        expect(
          existsSync(profile.directory),
          "the profile was removed without the settle-time registration — the control no longer reproduces the leak",
        ).toBe(true);
        expect(profile.removalCount()).toBe(0);
      } finally {
        reap(childPid);
        await expectTerminatedWithin(childPid, "the child the control killed");
        rmSync(profile.directory, { recursive: true, force: true });
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});
