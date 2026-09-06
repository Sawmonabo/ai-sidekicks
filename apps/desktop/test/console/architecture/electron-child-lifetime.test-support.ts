// The scaffolding the child-lifetime suite drives, and the reasons it exists.
//
// Split out of the suite rather than written inside it because the suite reached
// the size at which a file is doing two jobs: these are the STAND-INS — a real
// child with a real grandchild, a settlement this file can cause, a platform
// that refuses a kill on demand, a bounded reading of whether anything is left
// running — and the suite is the claims made with them. Nothing here asserts a
// lifetime rule; everything here makes one observable.
//
// It is a `.test-support` module, so its only legitimate dependents are the
// suites beside it, which is what `test-support-has-no-shipping-reader` in
// `.dependency-cruiser.mjs` enforces.

import process from "node:process";

import { expect, onTestFinished } from "vitest";

import {
  spawnManagedElectronChild,
  TEST_TIMEOUT_SLACK_MS,
  type ManagedElectronChild,
  type ProcessTreeTerminator,
  type SettleTimeDisposer,
} from "../../helpers/electron-child.js";
import { processHasTerminated, terminateProcessTree } from "../../helpers/process-tree.js";

/**
 * How long a settled kill is given to leave nothing running.
 *
 * Generous against the work it bounds — a group SIGKILL and a reap — because
 * the figure that matters is that it is BOUNDED, not that it is tight: an
 * assertion that waits forever on a zombie an init will not reap is the shape
 * this reading was introduced to stop producing.
 */
export const TERMINATION_OBSERVATION_MS = 2_000;

/** What the spawn and its grandchild announcement are given. */
const SPAWN_ANNOUNCEMENT_BUDGET_MS = 5_000;

/**
 * The per-test bound, DERIVED from the phases each case contains rather than
 * written down: the spawn and its announcement, then up to two terminations
 * observed in sequence, then the reserve every spawner in this package keeps
 * between its own bounds and vitest's.
 *
 * The relation is the module's own: a case's bounds fire first, so the kill it
 * schedules always runs. The settle-time registration below is what holds even
 * when that arithmetic is wrong.
 */
export const LIFETIME_TEST_TIMEOUT_MS: number =
  SPAWN_ANNOUNCEMENT_BUDGET_MS + 2 * TERMINATION_OBSERVATION_MS + TEST_TIMEOUT_SLACK_MS;

/** What a setup that abandons its child throws, so a case can name it. */
export const ABANDONED_SETUP_MESSAGE = "the setup failed after the child was already spawned";

/**
 * A registrar that records the disposer AND hands it to the runner.
 *
 * `settle()` is the suite's stand-in for the moment a test ends — by passing,
 * by failing, or by being killed at vitest's own timeout. All three run
 * `onTestFinished` callbacks, which is the property the production default
 * relies on and the reason the hook is the mechanism rather than a timer.
 *
 * The second half is not symmetry. With the recorder as the ONLY registrar, a
 * setup that never returned — a malformed announcement, a vitest timeout during
 * it — left a detached, deliberately non-terminating child running with nothing
 * anywhere that intended to kill it, which is precisely the leak this mechanism
 * exists to close, reintroduced by the suite that proves it closed. The recorder
 * OBSERVES; `onTestFinished` still owns the kill.
 */
export class RecordingSettleRegistrar {
  readonly #disposers: SettleTimeDisposer[] = [];

  readonly register = (dispose: SettleTimeDisposer): void => {
    this.#disposers.push(dispose);
    onTestFinished(dispose);
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
 * A tree terminator that refuses its first SIGKILL and then really terminates.
 *
 * The refusal is the case no platform can be asked to produce on demand: a
 * `taskkill` that spawns, exits non-zero, and leaves a live tree behind. The
 * second call delegates to the real terminator rather than answering a bare
 * `true`, so the retry it drives is a retry that actually kills something and
 * the case leaves nothing running.
 */
export class RefuseFirstKillTerminator {
  readonly #attempts: NodeJS.Signals[] = [];
  #refusalsRemaining = 1;

  get attempts(): readonly NodeJS.Signals[] {
    return this.#attempts;
  }

  readonly terminate: ProcessTreeTerminator = (processId, signal) => {
    this.#attempts.push(signal);
    if (signal === "SIGKILL" && this.#refusalsRemaining > 0) {
      this.#refusalsRemaining -= 1;
      return false;
    }
    return terminateProcessTree(processId, signal);
  };
}

/** The pids of a pair whose setup threw, read by the case that follows it. */
export class AbandonedPair {
  #childPid = 0;
  #grandchildPid = 0;

  record(pids: SpawnedPids): void {
    this.#childPid = pids.childPid;
    this.#grandchildPid = pids.grandchildPid;
  }

  get childPid(): number {
    return this.#childPid;
  }

  get grandchildPid(): number {
    return this.#grandchildPid;
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
 * the two kill paths the suite drives are distinguishable only because it is here.
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

/** The two pids a spawned pair occupies. */
export interface SpawnedPids {
  readonly childPid: number;
  readonly grandchildPid: number;
}

export interface SpawnedPair extends SpawnedPids {
  readonly managed: ManagedElectronChild;
}

export interface SpawnPairOptions {
  /** Drives the refusal case; the default is the real tree terminator. */
  readonly terminateProcessTree?: ProcessTreeTerminator;
  /** Reports the pids the moment both are known, before anything can throw. */
  readonly onSpawned?: (pids: SpawnedPids) => void;
  /** Throw instead of returning, the way a setup that fails mid-way does. */
  readonly abandonAfterAnnouncement?: boolean;
}

/** Spawn the pair and wait until the grandchild has announced its pid. */
export async function spawnChildWithGrandchild(
  registrar: RecordingSettleRegistrar,
  options: SpawnPairOptions = {},
): Promise<SpawnedPair> {
  const managed = spawnManagedElectronChild({
    command: process.execPath,
    args: ["-e", CHILD_PROGRAM],
    cwd: process.cwd(),
    env: process.env,
    registerSettleTimeTermination: registrar.register,
    terminateProcessTree: options.terminateProcessTree,
  });
  const childPid = managed.child.pid;
  if (childPid === undefined) {
    throw new Error("the child was given no pid, so nothing here is addressable");
  }

  const announcement = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    // One flag rather than listener removal: the `exit` listener stays attached
    // for the life of the child, and it MUST be inert once the announcement has
    // arrived, because every case in the suite then kills that child on purpose.
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
  options.onSpawned?.({ childPid, grandchildPid });
  if (options.abandonAfterAnnouncement === true) {
    // Stands in for every setup that spawns and then fails before it returns —
    // an announcement that will not parse, an assertion inside the helper, a
    // vitest timeout during it. The caller receives no handle, so the caller's
    // own cleanup cannot run, and the settle-time registration is all there is.
    throw new Error(ABANDONED_SETUP_MESSAGE);
  }
  return { managed, childPid, grandchildPid };
}

/** Resolves when the child has exited, carrying the signal that ended it. */
export function exitOf(managed: ManagedElectronChild): Promise<NodeJS.Signals | null> {
  return new Promise<NodeJS.Signals | null>((resolve) => {
    managed.child.once("exit", (_code, signal) => {
      resolve(signal);
    });
  });
}

/**
 * Wait, bounded, until `processId` will never run another instruction.
 *
 * A single read taken the instant the parent's `exit` fired is the wrong
 * instrument twice over: the grandchild's own death races that event, and a
 * grandchild that has died may sit unreaped, which `processExists` reports as
 * alive for as long as its new parent takes. `processHasTerminated` counts that
 * state as gone, and the poll is what makes the wait bounded rather than a
 * sleep whose length is a guess about someone else's init.
 */
export async function expectTerminatedWithin(processId: number, subject: string): Promise<void> {
  await expect
    .poll(() => processHasTerminated(processId), {
      timeout: TERMINATION_OBSERVATION_MS,
      message: `${subject} was still running ${String(TERMINATION_OBSERVATION_MS)} ms after the kill`,
    })
    .toBe(true);
}

/**
 * Reap a pid the suite is responsible for, whatever state it is in.
 *
 * The negative controls deliberately produce survivors, and a control that
 * proves a leak by leaking is not a control — it is the defect with a passing
 * assertion beside it.
 *
 * The guard is load-bearing rather than defensive: a pid that was never
 * recorded is `0`, and on POSIX `0` addresses the CALLER's own process group,
 * so passing it on would take this runner down with it.
 */
export function reap(processId: number): void {
  if (processId <= 0 || processHasTerminated(processId)) {
    return;
  }
  terminateProcessTree(processId, "SIGKILL");
}
