// The child a settling test kills, and the shapes that leave one running.
//
// This drives the real `spawnManagedElectronChild` against a real child process
// — a `node` that never exits, standing in for a hung Electron — because the
// defect being proved is about signals and process groups, and a fake child
// with a `kill` spy would prove only that the spy was called.
//
// Electron is deliberately NOT the child. The mechanism under test is the
// lifetime, not the binary: spawning Electron here would cost this tier a
// window, a profile, and a GPU context to observe a `SIGKILL` that a 40-byte
// Node program observes just as well. The one property that would be lost —
// that the launcher shim forwards signals the way this file assumes — is
// reconstructed exactly, by giving the child a grandchild of its own.
//
// The registrar is injected rather than taken from vitest, for a reason that is
// the point of the whole module: a test proving that a SETTLING test kills its
// child cannot itself be the settling test. Injecting it makes the settlement
// an event this file can cause and then observe. It is injected ALONGSIDE the
// real hook and never instead of it — `RecordingSettleRegistrar` states why.
//
// TERMINATION IS OBSERVED, NEVER SAMPLED. A group kill is delivered at once and
// reaped asynchronously, and the direct child's `exit` says nothing about the
// grandchild: on Linux a killed grandchild is reparented to init the instant it
// dies and sits there as a zombie until that init reaps it — which `kill(pid, 0)`
// answers "alive" for, and which a container init that does not reap never ends.
// So every assertion that something is gone is a BOUNDED observation of the
// liveness reading that counts a zombie as terminated, through vitest's own poll
// rather than a sleep loop.
//
// The stand-ins those two paragraphs describe live in
// `electron-child-lifetime.test-support.ts`; the claims made with them are here.

import { describe, expect, it } from "vitest";

import { PROCESS_TREE_TERMINATION_MODE, readProcessLiveness } from "../../helpers/process-tree.js";
import {
  AbandonedPair,
  ABANDONED_SETUP_MESSAGE,
  exitOf,
  expectTerminatedWithin,
  LIFETIME_TEST_TIMEOUT_MS,
  reap,
  RecordingSettleRegistrar,
  RefuseFirstKillTerminator,
  spawnChildWithGrandchild,
} from "./electron-child-lifetime.test-support.js";

describe("a spawned Electron child does not outlive the test that spawned it", () => {
  it(
    "is killed when the test finishes, with no timer having fired",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar);
      try {
        // The spawn registers exactly one disposer, and it is the only kill path
        // armed at this point: no deadline has been set and no timer is pending.
        expect(registrar.registeredCount).toBe(1);
        expect(readProcessLiveness(childPid)).toBe("running");
        expect(readProcessLiveness(grandchildPid)).toBe("running");

        const exited = exitOf(managed);
        await registrar.settle();

        const exitSignal = await exited;
        // Asserted only where the kill IS a signal. On Windows the tree is walked
        // by an external `taskkill /f`, so the child reports an exit code with
        // `signal === null`, and naming a signal here would be asserting a POSIX
        // detail on a platform that has none. What every platform owes is the
        // same, and is asserted on every platform: nothing left running.
        if (PROCESS_TREE_TERMINATION_MODE === "signal") {
          expect(exitSignal).toBe("SIGKILL");
        }
        expect(managed.isKilled).toBe(true);
        await expectTerminatedWithin(childPid, "the child");
        // The whole tree, not the handle the caller happened to hold.
        await expectTerminatedWithin(
          grandchildPid,
          "the grandchild — the detached spawn or the group signal regressed, and it",
        );
      } finally {
        reap(grandchildPid);
        reap(childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "counts a second kill as done rather than signalling a reaped pid again",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar);
      try {
        const exited = exitOf(managed);
        managed.dispose();
        await exited;
        expect(managed.isKilled).toBe(true);

        // Settling now runs the registered disposer a second time. On POSIX the
        // pid may already name a different process by the time a real run reaches
        // here, so the second pass must decide from the marker and signal nothing.
        await registrar.settle();
        expect(managed.terminate("SIGKILL")).toBe(true);
      } finally {
        reap(grandchildPid);
        reap(childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "asks again at the next settlement when a live tree refused the kill",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const terminator = new RefuseFirstKillTerminator();
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar, {
        terminateProcessTree: terminator.terminate,
      });
      try {
        // THE REFUSED KILL. The marker used to be set before the call, so this
        // settlement recorded a delivered SIGKILL that no process ever received,
        // and every later disposer returned early on it — leaving the tree the
        // platform refused to kill running, with nothing left that would ask
        // again. The abort inside `dispose` reaches the direct handle alone,
        // which is why the grandchild is the reading that shows it.
        await registrar.settle();
        expect(terminator.attempts).toStrictEqual(["SIGKILL"]);
        expect(managed.isKilled, "a refused kill was recorded as delivered").toBe(false);
        expect(readProcessLiveness(grandchildPid)).toBe("running");

        // The retry the marker would have suppressed, through the same door.
        await registrar.settle();
        expect(terminator.attempts).toStrictEqual(["SIGKILL", "SIGKILL"]);
        expect(managed.isKilled).toBe(true);
        await expectTerminatedWithin(grandchildPid, "the grandchild the retry was for");
      } finally {
        reap(grandchildPid);
        reap(childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});

describe("a setup that throws before it returns still gives its child up", () => {
  const abandoned = new AbandonedPair();

  it(
    "spawns, and then fails before the caller can hold the handle",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      await expect(
        spawnChildWithGrandchild(registrar, {
          onSpawned: (pids) => {
            abandoned.record(pids);
          },
          abandonAfterAnnouncement: true,
        }),
      ).rejects.toThrow(ABANDONED_SETUP_MESSAGE);
      expect(abandoned.childPid).toBeGreaterThan(0);
      expect(readProcessLiveness(abandoned.childPid)).toBe("running");
      // Deliberately NOT settled here, and nothing is reaped: the recorder's own
      // settlement is the path a failed setup never reaches, so the registration
      // the recorder makes with the runner is the only kill path left. Whether it
      // ran is the next case's question, and it can only be asked from there.
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "reaped that child at the end of the test that spawned it",
    async () => {
      expect(abandoned.childPid, "the case above recorded no pid to ask about").toBeGreaterThan(0);
      try {
        await expectTerminatedWithin(abandoned.childPid, "the abandoned child");
        await expectTerminatedWithin(abandoned.grandchildPid, "the abandoned grandchild");
      } finally {
        // The control must not leak even when it fails, which is the whole
        // difference between proving a leak and producing one.
        reap(abandoned.grandchildPid);
        reap(abandoned.childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});

describe("the two shapes that leave an Electron running — negative controls", () => {
  it(
    "leaks when the only kill path is a timer the worker teardown discards",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar);
      try {
        // THE SUPERSEDED SHAPE. A `setTimeout` inside the spawn promise is a claim
        // on the worker that armed it; when vitest's per-test timeout fires first
        // the worker is torn down and the timer is discarded with it. `clearTimeout`
        // is this file's stand-in for that teardown, because the timer never runs
        // either way and what matters is that the child is still there afterwards.
        const timerOnlyKill = setTimeout(() => {
          managed.child.kill("SIGKILL");
        }, 30_000);
        clearTimeout(timerOnlyKill);

        expect(
          readProcessLiveness(childPid),
          "the negative control must actually leak, or the positive case above proves nothing",
        ).toBe("running");
        expect(readProcessLiveness(grandchildPid)).toBe("running");
      } finally {
        // Through the real mechanism, which is also a second reading of it.
        await registrar.settle();
        reap(grandchildPid);
        reap(childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "leaks a grandchild when the kill goes to the handle instead of the group",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar);
      try {
        // THE MEASURED ORPHAN. `child.kill("SIGKILL")` on the launcher shim is
        // unforwardable by construction: it takes the shim down and leaves the
        // browser process reparented to init — which is the state the four
        // `sidekicks-gc-test-*` Electron processes were found in.
        const exited = exitOf(managed);
        managed.child.kill("SIGKILL");
        expect(await exited).toBe("SIGKILL");

        // Also the negative control for the zombie reading: this grandchild is
        // reparented and RUNNING, and a liveness probe that called it terminated
        // because its parent was gone would report every leak as a clean tree.
        expect(
          readProcessLiveness(grandchildPid),
          "the direct-handle kill reached the grandchild — the control no longer reproduces the orphan",
        ).toBe("running");
      } finally {
        reap(grandchildPid);
        await registrar.settle();
        reap(childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );
});
