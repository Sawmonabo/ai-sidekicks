// The provider-neutral terminal-emission gate (Plan-005 Phase 3, T3.14 —
// P1-1 intended close + P1-2-driver duplicate suppression).
//
// Both driver legs need exactly one guarantee at the moment a provider's
// terminal frame arrives: at most one terminal per `(runId, runVersion)` epoch
// reaches the emission pipeline, and the one that does carries whether a
// daemon-initiated close preceded it. The two legs previously each held their
// own near-verbatim copy of that logic, feeding ONE shared uniqueness index
// (the Plan-006 partial unique index) — two implementations of one invariant,
// which is one more than the invariant can survive.
//
// This module is that logic once, at `provider/` level, on the
// `NormalizedEventReorderBuffer` precedent: a provider-neutral mechanism the
// driver trees consume, never a driver module either tree imports from the
// other. Each driver keeps its own NAMED binding and its own census-specific
// inputs; what it no longer keeps is a second copy of the suppression rule.
//
// Deliberately NOT parameterized by provider name. Nothing here emits a
// diagnostic or a counter — a suppressed duplicate is ordinary provider
// behaviour this boundary exists to absorb, and a non-`project` route was
// already diagnosed by the thread-frame router — so a provider member would be
// a constructor parameter with no reader.
//
// Routing is CONSUMED here, never re-decided (T3.14's own routing clause): the
// gate takes the `ThreadFrameRoute` the T3.11 router already produced and
// settles a run only on `project`. A child thread's terminal therefore never
// settles the parent's run, and this boundary adds no second source of truth
// for whose stream a frame came from.
//
// Refs: Plan-005 §Phase 3 / T3.14 (P1-1, P1-2-driver), `Spec-006 §Run Lifecycle
// (run_lifecycle)`.

import type { ThreadFrameRoute } from "./thread-frame-router.js";

/** One terminal `run_lifecycle` frame as the emission boundary sees it. */
export interface TerminalRunFrame {
  readonly runId: string;
  /**
   * The run epoch. Supplied by the caller rather than read from the wire:
   * neither provider has a notion of a daemon run version, and `StartRunParams`
   * deliberately carries none, so the emission pipeline that owns the run
   * record supplies the second half of the uniqueness key.
   */
  readonly runVersion: number;
  /** The provider frame kind that produced the terminal, carried as data only. */
  readonly rawWireType: string;
  /** The T3.11 router's decision for this frame, consumed unchanged. */
  readonly route: ThreadFrameRoute;
}

/** Why a terminal frame did not settle its run. */
export type TerminalSuppressionReason =
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
      /** P1-1: `true` exactly when a daemon-initiated close preceded it. */
      readonly intendedClose: boolean;
    }
  | { readonly emit: false; readonly suppressionReason: TerminalSuppressionReason };

/**
 * The terminal-emission gate — one instance per provider session, held by that
 * driver's lifecycle module for the session's lifetime.
 *
 * Session-scoped rather than run-scoped because `closeSession` is a SESSION
 * operation: the intent it signals covers whichever run is still in flight when
 * the session goes down, and a run-scoped latch would need the lifecycle module
 * to already know which run the provider is about to terminate — which at
 * teardown is exactly what it does not know.
 */
export class TerminalEmissionGate {
  /**
   * How many settled epochs one session remembers.
   *
   * Bounded because a long session's run count is unbounded while the window a
   * duplicate arrives in is not: duplicates are same-turn (a terminal racing a
   * process exit) or same-teardown (the post-interrupt double), never hundreds
   * of runs later. Oldest-first eviction keeps the memory proportional to the
   * hazard rather than to session age.
   */
  static readonly DEFAULT_SETTLED_EPOCH_MEMORY = 256;

  readonly #settledEpochMemory: number;
  readonly #settledEpochKeysInOrder: string[] = [];
  readonly #settledEpochKeys = new Set<string>();
  #intendedCloseSignalled = false;

  constructor(options?: { readonly settledEpochMemory?: number }) {
    this.#settledEpochMemory =
      options?.settledEpochMemory ?? TerminalEmissionGate.DEFAULT_SETTLED_EPOCH_MEMORY;
  }

  /**
   * Signal a daemon-initiated close (P1-1). Called by the lifecycle module at
   * the top of `closeSession`, BEFORE teardown asks the provider to stop, so
   * the terminal the teardown provokes is already inside the intent.
   */
  signalIntendedClose(): void {
    this.#intendedCloseSignalled = true;
  }

  /** Whether a daemon-initiated close has been signalled for this session. */
  intendedCloseSignalled(): boolean {
    return this.#intendedCloseSignalled;
  }

  /**
   * Admit one terminal frame, returning whether it may be emitted and — when it
   * may — the `intendedClose` flag to stamp on its payload.
   *
   * Suppression is recorded in the return value rather than thrown: a duplicate
   * terminal is an ordinary provider behaviour this boundary exists to absorb,
   * not an error condition, and throwing here would surface it to a caller
   * whose only correct response is the suppression this method already
   * performed.
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
      intendedClose: this.#intendedCloseSignalled,
    };
  }

  /** Whether this epoch has already been settled by an emitted terminal. */
  hasSettledEpoch(runId: string, runVersion: number): boolean {
    return this.#settledEpochKeys.has(composeTerminalEpochKey(runId, runVersion));
  }
}

/**
 * The `(runId, runVersion)` uniqueness key.
 *
 * NUL is the separator because the daemon's provider-output validation seam
 * rejects it in every identity it admits, so no run id can carry one and
 * collide with a different id-plus-version pair by absorbing the separator;
 * `runVersion` is a number and contributes none either.
 */
function composeTerminalEpochKey(runId: string, runVersion: number): string {
  return `${runId}\u0000${String(runVersion)}`;
}
