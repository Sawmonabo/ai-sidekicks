// What a spawned child was HOLDING, and which paths actually release it.
//
// Its LIFETIME is `electron-child-lifetime.test.ts`'s subject and what `close`
// means to it is `electron-child-close-reading.test.ts`'s. This file asks the
// question that survives both being right: the child is dead and the temporary
// Chromium profile it ran on is still on disk, because the only code that would
// have removed it hangs off an event the outcome never delivered.
//
// THE SHAPE THAT LEAVES ONE BEHIND. A harness that spawns Electron removes its
// `--user-data-dir` from the child's own `close` handler — the ordinary path, and
// the one a pass takes. A vitest timeout takes neither: the worker is torn down
// with the test, `close` is delivered to nothing, and the handler that would have
// removed the directory is code that does not run. `spawnManagedElectronChild`
// binds the KILL to the test, which is what stops the process outliving the run;
// nothing in it binds the REMOVAL, which is why `cleanUpAfterChildAtSettleTime`
// exists and why a harness that does not call it accumulates one profile per
// overrun. Both of this package's Electron spawners now call it —
// `helpers/electron-probe.ts` for the smoke probe and `test/lifecycle.gc.test.ts`
// for the GC probe — and the cases below are what makes that a property rather
// than a convention.
//
// ONE REMOVER, REACHED TWICE. Registering the settle-time path does not retire
// the `close` path, and it must not: the fast path is what removes the directory
// while the test is still running rather than during its teardown. So on an
// ordinary run BOTH reach the same function, and the second call has to be a
// no-op rather than a throw — which is what `rmSync`'s `force` gives and what the
// idempotence case below drives directly.
//
// AND ONE REMOVER IS NOT ENOUGH IF THE KILL WAS REFUSED. The two settle-time
// disposers run in registration STACK order, so the cleanup registered by a
// harness runs BEFORE the one the spawn armed — invisible while every kill
// lands, and decisive on the one that does not. The refusal case below is what
// makes the retry a property rather than a comment: it is injected, because a
// `taskkill` that spawns, exits non-zero and leaves Electron running is not a
// state a platform can be asked for on demand.
//
// The stand-ins are `electron-child-lifetime.test-support.ts`'s and the bounded
// readings are `electron-child-liveness.test-support.ts`'s; the claims are here.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { describe, expect, it } from "vitest";

import { cleanUpAfterChildAtSettleTime } from "../../helpers/electron-child-cleanup.js";
import { spawnManagedElectronChild } from "../../helpers/electron-child.js";
import type {
  ManagedElectronChild,
  ProcessTreeTerminator,
} from "../../helpers/managed-electron-child.js";
import { readProcessLiveness } from "../../helpers/process-tree.js";
import {
  LIFETIME_TEST_TIMEOUT_MS,
  NON_TERMINATING_PROGRAM,
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
} from "./electron-child-lifetime.test-support.js";
import { expectTerminatedWithin, reap } from "./electron-child-liveness.test-support.js";

/**
 * What the refusal case gives each disposal attempt to produce a `close`.
 *
 * Shorter than the production grace on purpose, and injected rather than waited
 * out: every REFUSED attempt spends this bound in full against a child that was
 * never going to close, so the figure is what a refusal costs the suite. It is
 * still generous against the work the attempt that LANDS has to do — a group
 * SIGKILL against a `node -e` child and the stdio release behind its `close`.
 */
const REFUSED_KILL_SETTLE_WAIT_MS = 1_000;

/** A profile directory and the one function that takes it off disk, as a harness holds them. */
interface HeldProfile {
  readonly directory: string;
  /** How many times the remover has been called — one per path that reached it. */
  readonly removalCount: () => number;
  /** The ONE remover, exactly as both spawners spell it: best-effort and forced. */
  readonly removeProfileDirectory: () => void;
}

/**
 * A temporary profile plus the remover a harness reaches from every path.
 *
 * Written once here rather than per case because the claim under test is that
 * ONE function serves both paths — a second copy in the second case would make
 * the count that proves it meaningless.
 */
function heldProfile(): HeldProfile {
  const directory = mkdtempSync(path.join(tmpdir(), "sidekicks-profile-removal-"));
  let removals = 0;
  return {
    directory,
    removalCount: () => removals,
    removeProfileDirectory: () => {
      removals += 1;
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best-effort, as both spawners are: a leftover directory is a smaller
        // fact than whichever result the caller actually came for.
      }
    },
  };
}

/**
 * A child that will not exit on its own, spawned through the real chokepoint.
 *
 * The terminator is optional because only the refusal case needs one: every
 * other case wants a platform that kills what it is asked to kill, which is the
 * default, and passing `undefined` through reads as never having mentioned it.
 */
function spawnHoldingChild(
  registrar: RecordingSettleRegistrar,
  terminateProcessTree?: ProcessTreeTerminator,
): ManagedElectronChild {
  return spawnManagedElectronChild({
    command: process.execPath,
    args: ["-e", NON_TERMINATING_PROGRAM],
    cwd: process.cwd(),
    env: process.env,
    registerSettleTimeTermination: registrar.register,
    terminateProcessTree,
  });
}

describe("a settling test releases what its child was holding", () => {
  it(
    "removes what the child was holding, on the path no terminal event reaches",
    async () => {
      // The probe's temporary Chromium profile, in the state a vitest timeout
      // leaves it: the child is alive, so its `close` has not fired and never
      // will — the harness's own settlement is exactly the code that does not
      // run. Removal reached only from there is removal that never happens on
      // the outcome that most needs it, which is how a run accumulated one
      // profile directory per overrun.
      const registrar = new RecordingSettleRegistrar();
      const profile = heldProfile();
      const managed = spawnHoldingChild(registrar);
      const childPid = managed.child.pid ?? 0;

      // Whether the child had actually CLOSED by the time the removal ran — the
      // other half of the fix, and the half the outcome cannot show. On POSIX a
      // removal issued while the process is still exiting succeeds anyway, so
      // "the directory is gone" is true of a disposer that never waited; on
      // Windows that same removal fails against the live handles in the
      // directory. The event is the reading rather than the OS liveness, because
      // liveness is already terminated on this platform microseconds after the
      // SIGKILL and so answers the same for both orderings — an assertion that
      // cannot fail on a known-bad input is not a control.
      //
      // Read off the managed child rather than a listener of this case's own:
      // it records the delivery from its constructor, so it is already true when
      // the disposer that waited runs, and still false for one that removed in
      // the same turn as the kill.
      let closedWhenRemoved: boolean | null = null;
      cleanUpAfterChildAtSettleTime(
        managed,
        () => {
          closedWhenRemoved = managed.hasClosed;
          profile.removeProfileDirectory();
        },
        registrar.register,
      );

      try {
        // Non-vacuity: the directory is there and the child is running, so the
        // assertion after the settlement is about the settlement and not about a
        // directory that was already gone.
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
      // THE GC PROBE'S SHAPE, which is also the smoke probe's: a `close` handler
      // that settles the harness and removes the directory, and the settle-time
      // registration beside it for the outcomes that handler never sees. On the
      // ordinary run BOTH reach the remover — the disposer waits for `close`, so
      // the handler has already fired by the time it calls — and a remover that
      // could only be called once would turn a passing test into a teardown
      // failure. Driven here rather than reasoned about, because "idempotent" is
      // a property of `rmSync`'s `force` flag that a rewrite could drop silently.
      const registrar = new RecordingSettleRegistrar();
      const profile = heldProfile();
      const managed = spawnHoldingChild(registrar);
      const childPid = managed.child.pid ?? 0;

      managed.child.once("close", () => {
        managed.dispose();
        profile.removeProfileDirectory();
      });
      cleanUpAfterChildAtSettleTime(managed, profile.removeProfileDirectory, registrar.register);

      try {
        expect(profile.removalCount()).toBe(0);
        expect(existsSync(profile.directory)).toBe(true);

        await registrar.settle();

        expect(
          profile.removalCount(),
          "only one path reached the remover — the two are not both wired to the same function",
        ).toBe(2);
        expect(existsSync(profile.directory)).toBe(false);
        // The claim the count alone does not make: a further call on an already
        // removed directory neither throws nor reports a second removal as a
        // failure. Asked of the real remover, on the real absent directory.
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
      // THE ORDERING CASE. `dispose` signals, it does not wait, and a tree that
      // REFUSED the kill is still there when the bounded wait runs out — so this
      // disposer used to remove the profile under a live browser and leave the
      // actual kill to the disposer that runs after it, with no removal anywhere
      // behind that one. On Windows the removal under live handles fails
      // outright and the locked directory outlives the run, which is the exact
      // leak this module exists to close, reintroduced by the order the runner
      // picks rather than by anything a harness wrote.
      //
      // TWO refusals rather than one, so the claim does not rest on which
      // disposer consumes the first. Whichever order the settlement takes, the
      // cleanup's own first attempt is refused and only a retry of its own
      // reaches the kill; once the refusals are spent the stand-in delegates to
      // the real terminator, so the case leaves nothing running.
      const registrar = new RecordingSettleRegistrar();
      const profile = heldProfile();
      const terminator = new ObservedTreeTerminator(2);
      const managed = spawnHoldingChild(registrar, terminator.terminate);
      const childPid = managed.child.pid ?? 0;

      let closedWhenRemoved: boolean | null = null;
      cleanUpAfterChildAtSettleTime(
        managed,
        () => {
          closedWhenRemoved = managed.hasClosed;
          profile.removeProfileDirectory();
        },
        registrar.register,
        REFUSED_KILL_SETTLE_WAIT_MS,
      );

      try {
        expect(existsSync(profile.directory)).toBe(true);
        expect(readProcessLiveness(childPid)).toBe("running");

        await registrar.settle();

        // The finding's own claim first, and the termination reading after it.
        // By the time the settlement returns the retry has already waited for
        // `close`, so nothing here is waiting on the kill — and a rewrite that
        // stops retrying should report the ORDERING it broke rather than the
        // survivor that follows from it.
        expect(
          closedWhenRemoved,
          "the profile was removed while a refused kill still had the child alive — the disposal is not retried before the removal",
        ).toBe(true);
        expect(
          profile.removalCount(),
          "the retry reached the remover more than once — the removal is no longer the single act after the last wait",
        ).toBe(1);
        expect(existsSync(profile.directory)).toBe(false);
        // Non-vacuity, and the reading that separates a retry from a first ask
        // reported late: three SIGKILLs reached the terminator, so both refusals
        // were really consumed and the third was an ask this disposer made.
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
      // THE SUPERSEDED SHAPE, and the whole reason the registration above is not
      // decoration. The remover is reachable only from the child's own `close`,
      // which is by construction LATER than the settlement that kills the child —
      // and on the outcome this is a stand-in for, a vitest timeout, later never
      // arrives at all, because the worker holding the listener has been torn
      // down. So the reading taken the moment the settlement completes is the
      // reading a torn-down worker freezes forever.
      const registrar = new RecordingSettleRegistrar();
      const profile = heldProfile();
      const managed = spawnHoldingChild(registrar);
      const childPid = managed.child.pid ?? 0;

      managed.child.once("close", () => {
        profile.removeProfileDirectory();
      });

      try {
        expect(existsSync(profile.directory)).toBe(true);

        await registrar.settle();

        // Non-vacuity, and the guard that keeps this control honest: if `close`
        // HAD been delivered by now the directory would be gone for a reason
        // that has nothing to do with the missing registration, and the case
        // would be asserting the wrong thing quietly.
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
