// The scaffolding the child-lifetime suites drive, and the reasons it exists.
//
// Split out of the suite rather than written inside it because the suite reached
// the size at which a file is doing two jobs: these are the STAND-INS — a real
// child with a real grandchild, a settlement this file can cause, a platform
// that refuses a kill on demand — and the suite is the claims made with them.
// Nothing here asserts a lifetime rule; everything here makes one causable.
//
// The bounded READINGS of what a stand-in did — whether a pid is gone, when a
// terminal event arrived, and the reaper every negative control owes — sit in
// `electron-child-liveness.test-support.js` beside this, for the reason this
// file exists at all: causing a lifetime and observing one are two jobs, and
// two suites now read the second half.
//
// It is a `.test-support` module, so its only legitimate dependents are the
// suites beside it, which is what `test-support-has-no-shipping-reader` in
// `.dependency-cruiser.mjs` enforces.

import process from "node:process";

import { expect, onTestFinished } from "vitest";

import {
  spawnManagedElectronChild,
  TEST_TIMEOUT_SLACK_MS,
  type SettleTimeDisposer,
  type SettleTimeRegistrar,
} from "../../helpers/electron-child.js";
import type {
  ManagedElectronChild,
  ProcessTreeTerminator,
} from "../../helpers/managed-electron-child.js";
import { terminateProcessTree } from "../../helpers/process-tree.js";
import { TERMINATION_OBSERVATION_MS } from "./electron-child-liveness.test-support.js";

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

/** One call the tree terminator received, as the suite reads it back. */
export interface TerminationRequest {
  readonly processId: number;
  readonly signal: NodeJS.Signals;
}

/**
 * A tree terminator that records every request and can refuse the first N kills.
 *
 * ONE CLASS FOR ONE ROLE. Two cases need this stand-in for two different
 * reasons — one needs a platform that REFUSES on demand, the other needs to
 * learn which pid the module asked to kill — and both are the same role:
 * observing and optionally denying the call the module makes. A second class
 * for the second reason would be a second home for the same fact.
 *
 * The refusal is the case no platform can be asked to produce on demand: a
 * `taskkill` that spawns, exits non-zero, and leaves a live tree behind. Once
 * the refusals are used up the call delegates to the REAL terminator rather
 * than answering a bare `true`, so the retry it drives is a retry that actually
 * kills something and the case leaves nothing running.
 */
export class ObservedTreeTerminator {
  readonly #requests: TerminationRequest[] = [];
  #refusalsRemaining: number;

  constructor(refusedKills = 0) {
    this.#refusalsRemaining = refusedKills;
  }

  get requests(): readonly TerminationRequest[] {
    return this.#requests;
  }

  /**
   * The pid of the first tree this terminator was asked about, or `0`.
   *
   * `0` for "nothing was asked" rather than `undefined`, which is the same
   * convention `AbandonedPair` uses and for the same reason: `reap` refuses it,
   * so an unrecorded pid can never be signalled — and on POSIX `0` addresses
   * the CALLER's own process group.
   */
  get firstRequestedPid(): number {
    return this.#requests[0]?.processId ?? 0;
  }

  readonly terminate: ProcessTreeTerminator = (processId, signal) => {
    this.#requests.push({ processId, signal });
    if (signal === "SIGKILL" && this.#refusalsRemaining > 0) {
      this.#refusalsRemaining -= 1;
      return false;
    }
    return terminateProcessTree(processId, signal);
  };
}

/** What a registrar that refuses registration throws, so a case can name it. */
export const REGISTRAR_REFUSAL_MESSAGE = "onTestFinished() can only be called inside a test";

/**
 * A registrar that refuses, the way `onTestFinished` refuses outside a test.
 *
 * The misuse this stands in for is a spawn from `beforeAll`: legal-looking
 * code, a real child, and a registrar that throws AFTER the child exists. Vitest
 * cannot be asked to produce it from inside a running test — which is the same
 * reason the refusing terminator above is injected rather than provoked.
 */
export class RefusingSettleRegistrar {
  #registrationAttempts = 0;

  get registrationAttempts(): number {
    return this.#registrationAttempts;
  }

  readonly register: SettleTimeRegistrar = () => {
    this.#registrationAttempts += 1;
    throw new Error(REGISTRAR_REFUSAL_MESSAGE);
  };
}

/**
 * A child that will not exit on its own, and no grandchild.
 *
 * The misuse case reads the pid out of the terminator rather than out of a
 * returned handle — there is no returned handle, which is the whole defect —
 * and a grandchild whose pid nothing announced would be unobservable. The pid
 * that IS observable is the root's, and the root is what the claim is about.
 */
export const NON_TERMINATING_PROGRAM = "setInterval(() => {}, 60000);";

/**
 * A spawn through the real chokepoint whose settle-time registration refuses.
 *
 * Holds the two stand-ins so the case can read what the recovery did: whether
 * the registrar was reached at all, and which pid — if any — the module handed
 * the tree terminator on its way out.
 */
export class RefusedRegistrationSpawn {
  readonly #registrar = new RefusingSettleRegistrar();
  readonly #terminator = new ObservedTreeTerminator();

  /** Spawn, and let the registrar's refusal come back out. */
  readonly attempt = (): void => {
    spawnManagedElectronChild({
      command: process.execPath,
      args: ["-e", NON_TERMINATING_PROGRAM],
      cwd: process.cwd(),
      env: process.env,
      registerSettleTimeTermination: this.#registrar.register,
      terminateProcessTree: this.#terminator.terminate,
    });
  };

  get registrationAttempts(): number {
    return this.#registrar.registrationAttempts;
  }

  get terminationRequests(): readonly TerminationRequest[] {
    return this.#terminator.requests;
  }

  /** The pid the recovery asked the tree terminator to kill, or `0`. */
  get abandonedPid(): number {
    return this.#terminator.firstRequestedPid;
  }
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

/**
 * A child that hands its stdout to a grandchild and then exits on its own.
 *
 * The shape `close` exists for, and the one an exit code cannot see: the parent
 * is gone — `exit` fired, `exitCode` set, the pid reaped — while the pipe this
 * process reads is still held open by a descendant that inherited it. That is
 * the Electron shim exactly, one step smaller: the launcher exits and the
 * browser process it started keeps the inherited write end. The grandchild is
 * spawned ATTACHED for the same reason the pair above is, so it sits in the
 * group a tree kill addresses.
 *
 * The exit is deferred to the write callback because `process.exit` does not
 * flush an asynchronous pipe write, and the announcement is what the caller is
 * waiting for.
 */
const STDIO_HOLDING_CHILD_PROGRAM = [
  "const { spawn } = require('node:child_process');",
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], " +
    "{ stdio: ['ignore', 'inherit', 'inherit'] });",
  "process.stdout.write(JSON.stringify({ grandchildPid: grandchild.pid }) + '\\n', () => {",
  "  process.exit(0);",
  "});",
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
  /** Spawn the child that exits leaving its stdout held open by the grandchild. */
  readonly exitHoldingStdio?: boolean;
}

/** Spawn the pair and wait until the grandchild has announced its pid. */
export async function spawnChildWithGrandchild(
  registrar: RecordingSettleRegistrar,
  options: SpawnPairOptions = {},
): Promise<SpawnedPair> {
  const managed = spawnManagedElectronChild({
    command: process.execPath,
    args: ["-e", options.exitHoldingStdio === true ? STDIO_HOLDING_CHILD_PROGRAM : CHILD_PROGRAM],
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
    // One flag rather than listener removal: the failure listeners stay attached
    // for the life of the child, and they MUST be inert once the announcement has
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
    // `close` and not `exit`, because one of these programs exits ON PURPOSE
    // right after announcing and `exit` may be delivered before the pipe this
    // promise reads has been drained — which would reject a spawn that in fact
    // announced. `close` cannot: it arrives only once every stdio stream is
    // done, so by then the announcement has either been read or does not exist.
    managed.child.once("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("the child closed before it announced its grandchild"));
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
