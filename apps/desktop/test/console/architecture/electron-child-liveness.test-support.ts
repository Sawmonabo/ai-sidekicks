// Bounded observations of a spawned child's fate, and the reaper the controls owe.
//
// The second role the child-lifetime scaffolding holds, and it is a different
// one from the stand-ins beside it: `electron-child-lifetime.test-support.ts`
// makes a lifetime HAPPEN — a real child with a real grandchild, a settlement a
// suite can cause, a platform that refuses a kill on demand — and this makes one
// OBSERVABLE. Two suites read through it, which is why it is a module rather
// than a section of one.
//
// TERMINATION IS OBSERVED, NEVER SAMPLED. A group kill is delivered at once and
// reaped asynchronously, and the direct child's `exit` says nothing about the
// grandchild: on Linux a killed grandchild is reparented to init the instant it
// dies and sits there as a zombie until that init reaps it — which
// `kill(pid, 0)` answers "alive" for, and which a container init that does not
// reap never ends. So every assertion that something is gone is a BOUNDED
// observation of the liveness reading that counts a zombie as terminated,
// through vitest's own poll rather than a sleep loop.

import { expect } from "vitest";

import type { ManagedElectronChild } from "../../helpers/managed-electron-child.js";
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

/** Resolves when the child has exited, carrying the signal that ended it. */
export function exitOf(managed: ManagedElectronChild): Promise<NodeJS.Signals | null> {
  return new Promise<NodeJS.Signals | null>((resolve) => {
    managed.child.once("exit", (_code, signal) => {
      resolve(signal);
    });
  });
}

/**
 * Wait, bounded, until the child's own handle reports that it has exited.
 *
 * The reading settle-time cleanup used to take for "the child is gone", and the
 * one a case has to establish before it can ask whether `close` followed it.
 * `expectTerminatedWithin` below is NOT that reading and cannot stand in for
 * it: it counts an unreaped zombie as gone, while Node sets `exitCode` only
 * once it has reaped the child itself, so a case built on the pid reading
 * reaches its assertions with `exitCode` still `null` — which is a state the
 * superseded cleanup waited in rather than returned from, and a control built
 * on it proves nothing. Measured: it passed against the defect.
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
