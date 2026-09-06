// The child a settling test kills, and the two shapes that leave one running.
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
// an event this file can cause and then observe.

import process from "node:process";

import { describe, expect, it } from "vitest";

import {
  spawnManagedElectronChild,
  type ManagedElectronChild,
  type SettleTimeDisposer,
} from "../../helpers/electron-child.js";
import { processExists, terminateProcessTree } from "../../helpers/process-tree.js";

/**
 * A registrar that records the disposer instead of handing it to vitest.
 *
 * `settle()` is this file's stand-in for the moment a test ends — by passing,
 * by failing, or by being killed at vitest's own timeout. All three run
 * `onTestFinished` callbacks, which is the property the production default
 * relies on and the reason the hook is the mechanism rather than a timer.
 */
class RecordingSettleRegistrar {
  readonly #disposers: SettleTimeDisposer[] = [];

  readonly register = (dispose: SettleTimeDisposer): void => {
    this.#disposers.push(dispose);
  };

  get registeredCount(): number {
    return this.#disposers.length;
  }

  async settle(): Promise<void> {
    for (const dispose of this.#disposers) {
      await dispose();
    }
  }
}

/**
 * A child that never exits on its own, and a grandchild it leaves behind.
 *
 * The grandchild is what reconstructs the Electron shape without Electron.
 * `node_modules/.bin/electron` is a Node shim that spawns the real browser
 * process; a signal delivered to the shim alone reaches the browser only if the
 * shim survives to forward it, and SIGKILL cannot be forwarded. So the shape
 * that orphans a browser is exactly the shape that orphans this grandchild, and
 * the two kill paths below are distinguishable only because it is here.
 *
 * The grandchild is spawned ATTACHED, so it inherits the process group the
 * detached parent leads — which is the group `terminateProcessTree` addresses.
 */
const CHILD_PROGRAM = [
  "const { spawn } = require('node:child_process');",
  // A grandchild that outlives its parent unless the whole group is signalled.
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });",
  "process.stdout.write(JSON.stringify({ grandchildPid: grandchild.pid }) + '\\n');",
  "setInterval(() => {}, 60000);",
].join("\n");

interface SpawnedPair {
  readonly managed: ManagedElectronChild;
  readonly childPid: number;
  readonly grandchildPid: number;
}

/** Spawn the pair and wait until the grandchild has announced its pid. */
async function spawnChildWithGrandchild(registrar: RecordingSettleRegistrar): Promise<SpawnedPair> {
  const managed = spawnManagedElectronChild({
    command: process.execPath,
    args: ["-e", CHILD_PROGRAM],
    cwd: process.cwd(),
    env: process.env,
    registerSettleTimeTermination: registrar.register,
  });
  const childPid = managed.child.pid;
  if (childPid === undefined) {
    throw new Error("the child was given no pid, so nothing here is addressable");
  }

  const announcement = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    // One flag rather than listener removal: the `exit` listener stays attached
    // for the life of the child, and it MUST be inert once the announcement has
    // arrived, because every case below then kills that child on purpose.
    let settled = false;
    managed.child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffered += chunk.toString("utf8");
      const newlineIndex = buffered.indexOf("\n");
      if (newlineIndex < 0) return;
      settled = true;
      resolve(buffered.slice(0, newlineIndex));
    });
    managed.child.once("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    managed.child.once("exit", () => {
      if (settled) return;
      settled = true;
      reject(new Error("the child exited before it announced its grandchild"));
    });
  });
  const { grandchildPid } = JSON.parse(announcement) as { grandchildPid: number };
  expect(grandchildPid).toBeGreaterThan(0);
  return { managed, childPid, grandchildPid };
}

/** Resolves when the child has exited, carrying the signal that ended it. */
function exitOf(managed: ManagedElectronChild): Promise<NodeJS.Signals | null> {
  return new Promise<NodeJS.Signals | null>((resolve) => {
    managed.child.once("exit", (_code, signal) => {
      resolve(signal);
    });
  });
}

/**
 * Reap a pid this file is responsible for, whatever state it is in.
 *
 * The negative controls deliberately produce survivors, and a control that
 * proves a leak by leaking is not a control — it is the defect with a passing
 * assertion beside it.
 */
function reap(processId: number): void {
  if (!processExists(processId)) {
    return;
  }
  terminateProcessTree(processId, "SIGKILL");
}

describe("a spawned Electron child does not outlive the test that spawned it", () => {
  it("is killed when the test finishes, with no timer having fired", async () => {
    const registrar = new RecordingSettleRegistrar();
    const { managed, childPid, grandchildPid } = await spawnChildWithGrandchild(registrar);
    try {
      // The spawn registers exactly one disposer, and it is the only kill path
      // armed at this point: no deadline has been set and no timer is pending.
      expect(registrar.registeredCount).toBe(1);
      expect(processExists(childPid)).toBe(true);
      expect(processExists(grandchildPid)).toBe(true);

      const exited = exitOf(managed);
      await registrar.settle();

      expect(await exited).toBe("SIGKILL");
      expect(managed.isKilled).toBe(true);
      // The whole tree, not the handle the caller happened to hold.
      expect(
        processExists(grandchildPid),
        "the grandchild survived a group kill — the detached spawn or the group signal regressed",
      ).toBe(false);
    } finally {
      reap(grandchildPid);
      reap(childPid);
    }
  });

  it("counts a second kill as done rather than signalling a reaped pid again", async () => {
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
  });
});

describe("the two shapes that leave an Electron running — negative controls", () => {
  it("leaks when the only kill path is a timer the worker teardown discards", async () => {
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
        processExists(childPid),
        "the negative control must actually leak, or the positive case above proves nothing",
      ).toBe(true);
      expect(processExists(grandchildPid)).toBe(true);
    } finally {
      // Through the real mechanism, which is also a second reading of it.
      await registrar.settle();
      reap(grandchildPid);
      reap(childPid);
    }
  });

  it("leaks a grandchild when the kill goes to the handle instead of the group", async () => {
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

      expect(
        processExists(grandchildPid),
        "the direct-handle kill reached the grandchild — the control no longer reproduces the orphan",
      ).toBe(true);
    } finally {
      reap(grandchildPid);
      await registrar.settle();
      reap(childPid);
    }
  });
});
