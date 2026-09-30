// The child programs the lifetime suites drive, and the spawn that starts them.
//
// These are the real children (one with a real grandchild, one that exits leaving its stdout held
// open, one that never exits); the suites make the claims. Nothing here asserts a lifetime rule.
// What a spawn is handed is in `electron-child-doubles.test-support.ts`, and the bounded readings
// of what a child did are in `electron-child-liveness.test-support.ts`.
//
// As a `.test-support` module its only legitimate dependents are the suites beside it, enforced by
// `test-support-has-no-shipping-reader` in `.dependency-cruiser.mjs`.

import process from "node:process";

import { expect } from "vitest";

import {
  spawnManagedElectronChild,
  TEST_TIMEOUT_SLACK_MS,
  type ChildRelease,
} from "./electron-child.js";
import type { ManagedElectronChild, ProcessTreeTerminator } from "./managed-electron-child.js";
import type { SpawnedTreeIdentityCapture } from "./spawned-tree-record.js";
import {
  ObservedTreeTerminator,
  RefusingSettleRegistrar,
  type RecordingSettleRegistrar,
  type TerminationRequest,
} from "./electron-child-doubles.test-support.js";
import { TERMINATION_OBSERVATION_MS } from "./electron-child-liveness.test-support.js";

/** What the spawn and its grandchild announcement are given. */
const SPAWN_ANNOUNCEMENT_BUDGET_MS = 5_000;

/**
 * The per-test bound, derived from the phases each case contains: the spawn and its announcement,
 * up to two terminations observed in sequence, then the reserve every spawner keeps between its
 * own bounds and vitest's. A case's bounds fire first so the kill it schedules runs; the
 * settle-time registration holds even when that arithmetic is wrong.
 */
export const LIFETIME_TEST_TIMEOUT_MS: number =
  SPAWN_ANNOUNCEMENT_BUDGET_MS + 2 * TERMINATION_OBSERVATION_MS + TEST_TIMEOUT_SLACK_MS;

/** What a setup that abandons its child throws, so a case can name it. */
export const ABANDONED_SETUP_MESSAGE = "the setup failed after the child was already spawned";

/**
 * A child that will not exit on its own, and no grandchild.
 *
 * The misuse case reads the pid out of the terminator because no handle is returned, and a
 * grandchild whose pid nothing announced would be unobservable; the root is what the claim is
 * about.
 */
export const NON_TERMINATING_PROGRAM = "setInterval(() => {}, 60000);";

/**
 * A spawn through the real chokepoint whose settle-time registration refuses.
 *
 * Holds both doubles so a case can read whether the registrar was reached and which pid the
 * recovery handed the terminator.
 */
export class RefusedRegistrationSpawn {
  readonly #registrar = new RefusingSettleRegistrar();
  readonly #terminator: ObservedTreeTerminator;

  /** `refusedKills` denies the recovery's first asks. */
  constructor(refusedKills = 0) {
    this.#terminator = new ObservedTreeTerminator(refusedKills);
  }

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
 * The grandchild reconstructs the Electron shape without Electron: `node_modules/.bin/electron` is
 * a shim, and a signal to the shim alone reaches the browser only if the shim survives to forward
 * it, which SIGKILL cannot. It is spawned attached so it inherits the process group the detached
 * parent leads, which `terminateProcessTree` addresses.
 */
const CHILD_PROGRAM = [
  "const { spawn } = require('node:child_process');",
  // Outlives its parent unless the whole group is signaled.
  "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });",
  "process.stdout.write(JSON.stringify({ grandchildPid: grandchild.pid }) + '\\n');",
  "setInterval(() => {}, 60000);",
].join("\n");

/**
 * A child that hands its stdout to a grandchild and then exits on its own.
 *
 * The shape `close` exists for and an exit code cannot see: `exit` has fired and the pid is reaped
 * while a descendant still holds the pipe, like the Electron shim one step smaller. The grandchild
 * is attached for the same reason as above, and the exit waits for the write callback because
 * `process.exit` does not flush an asynchronous pipe write.
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

/** The pids plus the managed handle of a spawned pair. */
export interface SpawnedPair extends SpawnedPids {
  readonly managed: ManagedElectronChild;
}

/** Options for `spawnChildWithGrandchild`. */
export interface SpawnPairOptions {
  /** Drives the refusal case; the default is the real tree terminator. */
  readonly terminateProcessTree?: ProcessTreeTerminator;
  /** Reports the pids the moment both are known, before anything can throw. */
  readonly onSpawned?: (pids: SpawnedPids) => void;
  /** Throw instead of returning, the way a setup that fails mid-way does. */
  readonly abandonAfterAnnouncement?: boolean;
  /** Spawn the child that exits leaving its stdout held open by the grandchild. */
  readonly exitHoldingStdio?: boolean;
  /** Overrides the identity capture, and with it the readings it takes. */
  readonly captureRootIdentity?: SpawnedTreeIdentityCapture | undefined;
  /** What the spawn releases after its LAST termination attempt has settled. */
  readonly releaseAfterTermination?: ChildRelease | undefined;
  /** What each attempt is given to produce a `close`; the production grace by default. */
  readonly terminationExitWaitMs?: number | undefined;
}

/** Spawns the pair and waits until the grandchild has announced its pid. */
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
    captureRootIdentity: options.captureRootIdentity,
    releaseAfterTermination: options.releaseAfterTermination,
    terminationExitWaitMs: options.terminationExitWaitMs,
  });
  const childPid = managed.child.pid;
  if (childPid === undefined) {
    throw new Error("the child was given no pid, so nothing here is addressable");
  }

  const announcement = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    // One flag rather than listener removal: the failure listeners stay attached for the child's
    // life and must be inert once the announcement arrives, since every case then kills the child
    // on purpose.
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
    // `close`, not `exit`: one program exits on purpose right after announcing, and `exit` may
    // arrive before the pipe is drained, which would reject a spawn that did announce.
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
    // Stands in for a setup that spawns and then fails before returning. The caller gets no
    // handle, so only the settle-time registration can clean up.
    throw new Error(ABANDONED_SETUP_MESSAGE);
  }
  return { managed, childPid, grandchildPid };
}
