// What a bounded cleanup is handed and the verdict it returns. The race that produces the verdict
// is `bounded-cleanup.ts`.

import { type ProfileRemovalFailure } from "../launch/profile.js";

/** The launched application, reduced to what cleanup needs of it. */
export interface ClosableApplication {
  readonly close: () => Promise<void>;
  /** The launched process, or `undefined` once it has exited or was never spawned. */
  readonly processId: () => number | undefined;
}

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
   * disagree.
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
