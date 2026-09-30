// The child a settling test kills, and the shapes that leave one running.
//
// This drives the real `spawnManagedElectronChild` against a real `node` child that never exits,
// standing in for a hung Electron: the defect is about signals and process groups, and a fake
// child with a `kill` spy would prove only that the spy was called. Electron itself would cost a
// window, a profile and a GPU context to observe a SIGKILL a small Node program observes as well;
// the launcher shim is reconstructed by giving the child a grandchild of its own.
//
// The registrar is injected, alongside the real hook and never instead of it (see
// `RecordingSettleRegistrar`), because a test proving that a settling test kills its child cannot
// itself be the settling test.
//
// Termination is observed, never sampled. A killed grandchild is reparented to init and sits as a
// zombie until that init reaps it, which `kill(pid, 0)` reports alive and a non-reaping container
// init never ends. So each "is gone" assertion is a bounded observation, through vitest's poll, of
// the liveness reading that counts a zombie as terminated.
//
// The children are in `electron-child-lifetime.test-support.ts` and what a spawn is handed is in
// `electron-child-doubles.test-support.ts`. What the child held (the temporary profile) is
// `electron-child-profile-removal.test.ts`.

import { describe, expect, it } from "vitest";

import { PROCESS_TREE_TERMINATION_MODE } from "./process-tree/termination.js";
import { readProcessLiveness } from "./process-tree/liveness.js";
import {
  ObservedTreeTerminator,
  RecordingSettleRegistrar,
  REGISTRAR_REFUSAL_MESSAGE,
} from "./electron-child-doubles.test-support.js";
import {
  ABANDONED_SETUP_MESSAGE,
  AbandonedPair,
  LIFETIME_TEST_TIMEOUT_MS,
  RefusedRegistrationSpawn,
  spawnChildWithGrandchild,
} from "./electron-child-lifetime.test-support.js";
import { exitOf, expectTerminatedWithin, reap } from "./electron-child-liveness.test-support.js";

describe("a spawned Electron child does not outlive the test that spawned it", () => {
  it(
    "is killed when the test finishes, with no timer having fired",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar);
      try {
        // The spawn registers exactly one disposer, the only kill path armed: no deadline or timer
        // is pending.
        expect(registrar.registeredCount).toBe(1);
        expect(readProcessLiveness(childPid)).toBe("running");
        expect(readProcessLiveness(grandchildPid)).toBe("running");

        const exited = exitOf(managed);
        await registrar.settle();

        const exitSignal = await exited;
        // Asserted only where the kill is a signal: on Windows `taskkill /f` walks the tree, so
        // the child reports an exit code with `signal === null`. Every platform owes the same
        // result, asserted everywhere: nothing left running.
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
    "counts a second kill as done rather than signaling a reaped pid again",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar);
      try {
        const exited = exitOf(managed);
        managed.dispose();
        await exited;
        expect(managed.isKilled).toBe(true);

        // Settling runs the registered disposer a second time. The pid may already name a
        // different process on POSIX, so the second pass must decide from the marker and signal
        // nothing.
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
    "keeps the root a refused kill left, and asks again inside the one settlement",
    async () => {
      const registrar = new RecordingSettleRegistrar();
      const terminator = new ObservedTreeTerminator(1);
      const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar, {
        terminateProcessTree: terminator.terminate,
      });
      try {
        // A refused kill must leave two things behind. It is asked of one disposal, not a
        // settlement, because a settlement is the whole bounded retry. The marker must record the
        // verdict (a refusal is not a delivered SIGKILL), and the direct handle must survive: the
        // abort would take the root down, and a tree is addressed through its root, so the retry
        // would walk from a pid that no longer names the tree.
        managed.dispose();
        expect(terminator.requests).toStrictEqual([{ processId: childPid, signal: "SIGKILL" }]);
        expect(managed.isKilled, "a refused kill was recorded as delivered").toBe(false);
        expect(
          managed.directHandleReleased,
          "the direct handle was released over a refused tree kill, so the retry has no root to walk",
        ).toBe(false);
        expect(
          readProcessLiveness(childPid),
          "the root the retry is addressed through was killed by the abort",
        ).toBe("running");
        expect(readProcessLiveness(grandchildPid)).toBe("running");

        // The retry walks the root the refusal preserved, inside the one settlement, because a
        // resource release is sequenced after the last attempt and a deferred retry would land
        // after it.
        await registrar.settle();
        expect(terminator.requests).toHaveLength(2);
        expect(managed.isKilled).toBe(true);
        // Still false after the delivered kill: the abort is not a second attempt at the tree, and
        // a child with a pid never sees it fire.
        expect(managed.directHandleReleased).toBe(false);
        await expectTerminatedWithin(childPid, "the root the retry walked from");
        await expectTerminatedWithin(grandchildPid, "the grandchild the retry was for");
      } finally {
        reap(grandchildPid);
        reap(childPid);
      }
    },
    LIFETIME_TEST_TIMEOUT_MS,
  );

  it(
    "gives the child up when the settle-time registration itself refuses",
    async () => {
      // Misuse with a child in it: `onTestFinished` throws outside a running test (a spawn from
      // `beforeAll`), after the spawn, leaving a detached child no handle reaches. The pid comes
      // from the terminator because no handle is returned.
      const refused = new RefusedRegistrationSpawn();
      expect(refused.attempt).toThrow(REGISTRAR_REFUSAL_MESSAGE);
      expect(refused.registrationAttempts).toBe(1);

      const abandonedPid = refused.abandonedPid;
      try {
        expect(
          refused.terminationRequests,
          "the refusal was rethrown without disposing — nothing was ever asked to kill the child",
        ).toHaveLength(1);
        expect(abandonedPid).toBeGreaterThan(0);
        await expectTerminatedWithin(
          abandonedPid,
          "the child a refused registration abandoned, which no handle can reach, and it",
        );
      } finally {
        reap(abandonedPid);
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
      // Deliberately not settled or reaped: a failed setup never reaches the recorder's own
      // settlement, so its registration with the runner is the only kill path left, which the
      // next case checks.
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
        // The control must not leak even when it fails.
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
        // The superseded shape: a `setTimeout` inside the spawn promise is discarded with the
        // worker when vitest's per-test timeout fires first. `clearTimeout` stands in for that
        // teardown; the child must still be there afterwards.
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
        // Through the real mechanism, a second reading of it.
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
        // The measured orphan: `child.kill("SIGKILL")` on the launcher shim cannot be forwarded,
        // so it takes the shim down and leaves the browser reparented to init, the state the four
        // `sidekicks-gc-test-*` Electron processes were found in.
        const exited = exitOf(managed);
        managed.child.kill("SIGKILL");
        expect(await exited).toBe("SIGKILL");

        // Also the negative control for the zombie reading: this grandchild is reparented and
        // running, and a probe that called it terminated because its parent is gone would report
        // every leak as clean.
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
