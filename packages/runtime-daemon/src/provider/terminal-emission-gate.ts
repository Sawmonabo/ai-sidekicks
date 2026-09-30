// The provider-neutral terminal-emission gate: intended-close signaling plus duplicate-terminal
// suppression. At most one terminal per `(runId, runVersion)` epoch reaches the emission
// pipeline, and it carries whether a daemon-initiated close preceded it. Both drivers use this
// one implementation so the invariant is not duplicated.
//
// The gate is not parameterized by provider: it emits no diagnostic or counter, because a
// suppressed duplicate is ordinary provider behavior and the thread-frame router already
// diagnosed any frame it did not route to the session's own thread. It consumes the router's
// `ThreadFrameRoute` and settles a run only on `project`.

import type { ThreadFrameRoute } from "./thread-frame-router.js";

/** One terminal `run_lifecycle` frame as the emission boundary sees it. */
export interface TerminalRunFrame {
  readonly runId: string;
  /** The run epoch, supplied by the caller because no provider frame carries a run version. */
  readonly runVersion: number;
  /** The provider frame kind that produced the terminal, carried as data only. */
  readonly rawWireType: string;
  /** The router's decision for this frame, consumed unchanged. */
  readonly route: ThreadFrameRoute;
}

/** Why a terminal frame did not settle its run. */
type TerminalSuppressionReason =
  /** A terminal for this `(runId, runVersion)` epoch already settled it. */
  | "duplicate-terminal-epoch"
  /** The router did not route this frame to the session's own thread. */
  | "not-the-session-thread";

/** The boundary's decision for one terminal frame. */
export type TerminalEmissionDecision =
  | {
      readonly emit: true;
      readonly runId: string;
      readonly runVersion: number;
      /** `true` exactly when a daemon-initiated close preceded it. */
      readonly intendedClose: boolean;
    }
  | { readonly emit: false; readonly suppressionReason: TerminalSuppressionReason };

/**
 * The terminal-emission gate: one instance per provider session, held by that driver's lifecycle
 * module. It is session-scoped because a close covers whichever run is in flight at teardown,
 * and the lifecycle module does not know which run that is.
 */
export class TerminalEmissionGate {
  /**
   * How many settled epochs one session remembers. A duplicate arrives in the same turn or the
   * same teardown, never hundreds of runs later, so the oldest epoch is evicted first.
   */
  static readonly DEFAULT_SETTLED_EPOCH_MEMORY = 256;

  readonly #settledEpochMemory: number;
  readonly #settledEpochKeysInOrder: string[] = [];
  readonly #settledEpochKeys = new Set<string>();
  #intendedCloseSignaled = false;

  constructor(options?: { readonly settledEpochMemory?: number }) {
    this.#settledEpochMemory =
      options?.settledEpochMemory ?? TerminalEmissionGate.DEFAULT_SETTLED_EPOCH_MEMORY;
  }

  /**
   * Signal a daemon-initiated close. Call it at the top of `closeSession`, before teardown asks
   * the provider to stop, so the terminal the teardown provokes carries the intent.
   */
  signalIntendedClose(): void {
    this.#intendedCloseSignaled = true;
  }

  /** Whether a daemon-initiated close has been signaled for this session. */
  intendedCloseSignaled(): boolean {
    return this.#intendedCloseSignaled;
  }

  /**
   * Admit one terminal frame, returning whether it may be emitted and the `intendedClose` flag
   * for its payload. A suppressed frame is returned, never thrown: a duplicate is ordinary
   * provider behavior.
   */
  admitTerminalFrame(frame: TerminalRunFrame): TerminalEmissionDecision {
    if (frame.route.decision !== "project") {
      return { emit: false, suppressionReason: "not-the-session-thread" };
    }
    const epochKey = composeTerminalEpochKey(frame.runId, frame.runVersion);
    if (this.#settledEpochKeys.has(epochKey)) {
      return { emit: false, suppressionReason: "duplicate-terminal-epoch" };
    }
    this.#settledEpochKeys.add(epochKey);
    this.#settledEpochKeysInOrder.push(epochKey);
    if (this.#settledEpochKeysInOrder.length > this.#settledEpochMemory) {
      const evicted = this.#settledEpochKeysInOrder.shift();
      if (evicted !== undefined) {
        this.#settledEpochKeys.delete(evicted);
      }
    }
    return {
      emit: true,
      runId: frame.runId,
      runVersion: frame.runVersion,
      intendedClose: this.#intendedCloseSignaled,
    };
  }

  /** Whether this epoch has already been settled by an emitted terminal. */
  hasSettledEpoch(runId: string, runVersion: number): boolean {
    return this.#settledEpochKeys.has(composeTerminalEpochKey(runId, runVersion));
  }
}

/**
 * The `(runId, runVersion)` uniqueness key. NUL separates the parts because a run id is a UUID
 * and a version is a number, so neither can contain one and two pairs cannot collide.
 */
function composeTerminalEpochKey(runId: string, runVersion: number): string {
  return `${runId}\u0000${String(runVersion)}`;
}
