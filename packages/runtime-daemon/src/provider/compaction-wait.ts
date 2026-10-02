/**
 * The pending-compaction wait, shared by both driver legs. Both mechanisms answer before the work
 * is done (an empty acknowledgement, or no answer to the command frame at all), so `applied` is
 * admitted only by the provider's typed compaction frame: dispatch, then wait for it.
 *
 * - The wait ends when the driver's bound elapses (one timer per waiter, no polling) or the
 *   binding stops being live (pushed in from the driver's disposal paths).
 * - `observeBoundary` taps the frame's ordinary route; a late frame still normalizes into
 *   `usage.context_compacted` whether or not anyone waits.
 * - Settlement is per key; withdrawal is per waiter and is not a settlement.
 */

// `observed` alone admits `applied`; the caller maps the other two onto its own
// `DriverCompactionResult` failure reasons.
type CompactionWaitTerminal = "observed" | "wait_expired" | "binding_lost";

/** The settlement handed back to one waiter; `boundaryPosition` is `null` unless observed. */
export interface CompactionWaitSettlement {
  readonly terminal: CompactionWaitTerminal;
  readonly boundaryPosition: number | null;
}

/**
 * How long a user-triggered compaction waits for typed evidence before it is reported failed: a
 * bound the daemon publishes, not a provider figure, and longer than a request deadline because
 * compaction is model work. The provider is never canceled; a late frame keeps its ordinary route.
 */
export const COMPACTION_WAIT_MS = 120_000;

/** Schedules a one-shot callback and returns its canceler; injected so tests skip real waits. */
export type CompactionWaitScheduler = (callback: () => void, delayMs: number) => () => void;

// Carries `settle` alone, so a key-wide pass cannot cancel a sibling's timer.
interface RegisteredCompactionWait {
  readonly settle: (settlement: CompactionWaitSettlement) => void;
}

/**
 * One armed wait. `settled` never settles after `abandon()` (any terminal would report an event
 * that did not happen), so a caller abandons on a failed dispatch and awaits on a successful one.
 */
export interface ArmedCompactionWait {
  /** Resolves on the wait's terminal; never rejects, never settles once withdrawn. */
  readonly settled: Promise<CompactionWaitSettlement>;
  /** Cancels this waiter's timer and registration. Idempotent; touches no sibling waiter. */
  abandon(): void;
}

/**
 * The pending compactions of one driver, keyed by the driver's own address for a live binding.
 * The key must name the binding a wait was dispatched under, so a path that replaces the binding
 * can release its stranded waits: a driver keys on session id, or on session id and thread id
 * where a fork re-points the record and a resume installs a new one, releasing the old key at
 * both.
 */
export class PendingCompactionRegistry {
  readonly #waitsByKey: Map<string, Set<RegisteredCompactionWait>> = new Map();
  readonly #scheduleTimeout: CompactionWaitScheduler;

  constructor(scheduleTimeout: CompactionWaitScheduler) {
    this.#scheduleTimeout = scheduleTimeout;
  }

  /**
   * Arms a wait for `key`. Arm before dispatching: a frame delivered between the request resolving
   * and the registration would hit an empty registry and the caller would wait out the full bound.
   * `settled` never rejects.
   */
  arm(key: string, boundMs: number): ArmedCompactionWait {
    // Assigned inside the executor (which runs synchronously) to share its `closed` flag.
    let abandon!: () => void;
    const settled = new Promise<CompactionWaitSettlement>((resolve) => {
      let closed = false;
      const settleOnce = (settlement: CompactionWaitSettlement): void => {
        if (closed) {
          return;
        }
        closed = true;
        this.#forget(key, registration);
        resolve(settlement);
      };

      const cancelTimer = this.#scheduleTimeout(() => {
        settleOnce({ terminal: "wait_expired", boundaryPosition: null });
      }, boundMs);

      const registration: RegisteredCompactionWait = {
        settle: (settlement) => {
          cancelTimer();
          settleOnce(settlement);
        },
      };

      abandon = (): void => {
        if (closed) {
          return;
        }
        // Close first: a canceler that fails to stop its timer must not settle a withdrawn wait.
        closed = true;
        cancelTimer();
        this.#forget(key, registration);
      };

      const existing = this.#waitsByKey.get(key);
      if (existing === undefined) {
        this.#waitsByKey.set(key, new Set([registration]));
      } else {
        existing.add(registration);
      }
    });
    return { settled, abandon };
  }

  /** A typed compaction frame arrived on `key`: settles every waiter; a no-op with none armed. */
  observeBoundary(key: string, boundaryPosition: number | null): void {
    this.#settleAll(key, { terminal: "observed", boundaryPosition });
  }

  /** The binding behind `key` is gone (teardown, quarantine): settles every waiter. Idempotent. */
  releaseBinding(key: string): void {
    this.#settleAll(key, { terminal: "binding_lost", boundaryPosition: null });
  }

  /** How many waits are armed for `key`. */
  pendingCountFor(key: string): number {
    return this.#waitsByKey.get(key)?.size ?? 0;
  }

  #settleAll(key: string, settlement: CompactionWaitSettlement): void {
    const waits = this.#waitsByKey.get(key);
    if (waits === undefined) {
      return;
    }
    // Snapshot first: each `settle` deletes its own registration from this set.
    for (const wait of [...waits]) {
      wait.settle(settlement);
    }
  }

  #forget(key: string, registration: RegisteredCompactionWait): void {
    const waits = this.#waitsByKey.get(key);
    if (waits === undefined) {
      return;
    }
    waits.delete(registration);
    if (waits.size === 0) {
      // Drop the key with its last waiter, so no empty Set lingers per session.
      this.#waitsByKey.delete(key);
    }
  }
}
