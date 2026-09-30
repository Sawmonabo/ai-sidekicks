// The contract of a bounded cleanup: the collaborators it is handed, the clock it charges its
// phases against, and the verdict it returns. The race that produces the verdict is
// `bounded-cleanup.ts`.
//
// The seams make that race checkable: no fixture makes a browser refuse to close, no `rmSync`
// over an owned directory fails on POSIX, no platform can be asked to refuse a kill, and no real
// clock spends a five-second host query on request.

import { terminateProcessTree } from "./process-tree/termination.js";
import { processHasTerminated } from "./process-tree/liveness.js";
import { type ProfileRemovalFailure } from "./launch-profile.js";

/**
 * The launched application, reduced to what cleanup needs of it.
 *
 * An interface rather than Playwright's `ElectronApplication` so a test can stub a `close()`
 * that never settles.
 */
export interface ClosableApplication {
  readonly close: () => Promise<void>;
  /** The launched process, or `undefined` once it has exited or was never spawned. */
  readonly processId: () => number | undefined;
}

/**
 * Force-termination, as a seam.
 *
 * A constructor argument so a test can assert the SIGKILL without signaling anything: a real
 * terminator would signal a whole process group from inside the runner.
 */
export interface ProcessTerminator {
  /**
   * Kills the tree led by `processId`. Returns whether a signal was delivered.
   *
   * `remainingBudgetMilliseconds` is what is left of the termination deadline at the call. A tree
   * kill is several blocking host commands, each held to `HOST_QUERY_TIMEOUT_MS` alone; the
   * implementation turns this figure into one deadline for the whole call and spawns nothing once
   * it reaches zero. A caller therefore charges it against its own clock once.
   */
  readonly terminate: (processId: number, remainingBudgetMilliseconds: number) => boolean;
  /**
   * Whether that process may still execute, asked without signaling it.
   *
   * A pid that still answers is not the question: an exited, unreaped process holds its pid and
   * will never run again, which is what a group SIGKILL leaves every grandchild as, and reading
   * it as alive reports `unterminable` over a tree that is gone. Charged to the same deadline as
   * `terminate` (on macOS this runs `ps`); at or below zero it spawns nothing and answers "still
   * there", so the cleanup keeps escalating.
   */
  readonly isRunning: (processId: number, remainingBudgetMilliseconds: number) => boolean;
}

/**
 * The wall clock a cleanup charges its phases against, as a seam.
 *
 * Injected so a test can spend a whole `HOST_QUERY_TIMEOUT_MS` per synchronous host query without
 * waiting for it; the pause between attempts still needs a real macrotask.
 */
export type CleanupClock = () => number;

/**
 * How the close settled.
 *
 * `unterminable` is distinct from `terminated` because it means a process may still be running and
 * holding a profile, the one outcome that can affect a later launch. `closed-after-rejection` is
 * distinct from `closed` because the close failed while the process is gone: nothing leaked, but
 * the rejection must still be surfaced.
 */
export type CleanupSettlement = "closed" | "closed-after-rejection" | "terminated" | "unterminable";

/** The verdict of one bounded cleanup. */
export interface CleanupOutcome {
  readonly settlement: CleanupSettlement;
  /** Why `application.close()` rejected; present on every settlement reached through it. */
  readonly closeRejection?: unknown;
  /** Wall milliseconds spent closing, measured driver-side. */
  readonly waitedMs: number;
  /**
   * The bound this close was held to, in milliseconds.
   *
   * Reported rather than re-derived by readers so a message and the race that produced it cannot
   * disagree when a test supplies a shorter bound.
   */
  readonly budgetMs: number;
  /** The process the settlement is about, when still addressable, so a failure can name it. */
  readonly processId?: number | undefined;
  /**
   * The launch profile still on disk, when removing it failed.
   *
   * Independent of the settlement: a close can succeed while the removal fails. Absent means the
   * directory is gone.
   */
  readonly profileRemovalFailure?: ProfileRemovalFailure | undefined;
}

/**
 * The terminator every real launch uses, over the shared implementation in `process-tree/`.
 *
 * `BoundedCleanup` still takes the terminator as an argument so a test signals nothing.
 */
export const ELECTRON_PROCESS_TERMINATOR: ProcessTerminator = {
  // `processHasTerminated`, not `processExists`: it counts an unreaped zombie as gone. Both
  // members forward the remaining budget; dropping it would put the whole
  // `HOST_QUERY_TIMEOUT_MS` back outside this cleanup's deadline.
  isRunning: (processId: number, remainingBudgetMilliseconds: number): boolean =>
    !processHasTerminated(processId, remainingBudgetMilliseconds),
  // The signal and the unverified root identity are `terminateProcessTree`'s own defaults, so
  // they are passed as `undefined`.
  terminate: (processId: number, remainingBudgetMilliseconds: number): boolean =>
    terminateProcessTree(processId, undefined, undefined, remainingBudgetMilliseconds),
};
