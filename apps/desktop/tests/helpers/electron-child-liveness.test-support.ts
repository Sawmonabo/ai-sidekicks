// Bounded observations of a spawned child's fate, and the reaper the controls owe.
//
// `electron-child-lifetime.test-support.ts` makes a lifetime happen and
// `electron-child-doubles.test-support.ts` stands in for what a spawn is handed; this makes a
// lifetime observable. Two suites read through it.
//
// Termination is observed, never sampled. A killed grandchild is reparented to init and sits as a
// zombie until that init reaps it, which `kill(pid, 0)` reports alive and a non-reaping container
// init never ends, and the direct child's `exit` says nothing about the grandchild. So each "is
// gone" assertion is a bounded observation, through vitest's poll, of the liveness reading that
// counts a zombie as terminated.

import { expect } from "vitest";

import type { ManagedElectronChild } from "./managed-electron-child.js";
import { terminateProcessTree } from "./process-tree/termination.js";
import { processHasTerminated } from "./process-tree/liveness.js";

/**
 * How long a settled kill is given to leave nothing running.
 *
 * Generous against a group SIGKILL and a reap; what matters is that it is bounded, so an
 * assertion never waits forever on a zombie an init will not reap.
 */
export const TERMINATION_OBSERVATION_MS = 2_000;

/** Resolves when the child has exited, carrying the signal that ended it. */
export function exitOf(managed: ManagedElectronChild): Promise<NodeJS.Signals | null> {
  return new Promise<NodeJS.Signals | null>((resolve) => {
    managed.child.once("exit", (_code, signal) => {
      resolve(signal);
    });
  });
}

/**
 * Waits, bounded, until the child's own handle reports that it has exited.
 *
 * A case establishes this before asking whether `close` followed. `expectTerminatedWithin` cannot
 * stand in for it: it counts an unreaped zombie as gone, while Node sets `exitCode` only once it
 * has reaped the child, so a case built on the pid reading reaches its assertions with `exitCode`
 * still `null`.
 */
export async function expectExitReported(managed: ManagedElectronChild): Promise<void> {
  await expect
    .poll(() => managed.child.exitCode !== null || managed.child.signalCode !== null, {
      timeout: TERMINATION_OBSERVATION_MS,
      message: "the child's handle never reported an exit, so the gap before `close` never opened",
    })
    .toBe(true);
}

/**
 * Waits, bounded, until `processId` will never run another instruction.
 *
 * A single read at the parent's `exit` is wrong twice: the grandchild's death races that event,
 * and a dead grandchild may sit unreaped, which `processExists` reports alive.
 * `processHasTerminated` counts that as gone.
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
 * Reaps a pid the suite is responsible for, whatever state it is in.
 *
 * Negative controls produce survivors, and a control must not leak. The guard is load-bearing: a
 * pid never recorded is `0`, which on POSIX addresses the caller's own process group.
 */
export function reap(processId: number): void {
  if (processId <= 0 || processHasTerminated(processId)) {
    return;
  }
  terminateProcessTree(processId, "SIGKILL");
}
