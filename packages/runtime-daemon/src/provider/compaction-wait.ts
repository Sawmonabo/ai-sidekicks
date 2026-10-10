/**
 * The pending-compaction wait, shared by both driver legs. Both mechanisms answer before the work
 * is done (an empty acknowledgement, or no answer to the command frame at all), so `applied` is
 * admitted only by the provider's typed compaction frame: dispatch, then wait for it.
 *
 * - The wait has no time limit of its own: it ends when the frame arrives, when the provider ends
 *   the compaction's turn without one, or when the binding stops being live (pushed in from the
 *   driver's disposal paths).
 * - `observeBoundary` taps the frame's ordinary route; a late frame still normalizes into
 *   `usage.context_compacted` whether or not anyone waits.
 * - Settlement is per key; withdrawal is per waiter and is not a settlement.
 */

// `observed` alone admits `applied`; the caller maps `not_compacted` and `binding_lost` onto its own
// `DriverCompactionResult` failure reasons.
type CompactionWaitTerminal = "observed" | "not_compacted" | "binding_lost";

/** The settlement handed back to one waiter; `boundaryPosition` is `null` unless observed. */
export interface CompactionWaitSettlement {
  readonly terminal: CompactionWaitTerminal;
  readonly boundaryPosition: number | null;
}

// One waiter's registration, through which a key-wide pass settles it.
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
  /** Cancels this waiter's registration. Idempotent; touches no sibling waiter. */
  abandon(): void;
}

/** Why a wait settled with no compaction, in words for the driver's diagnostic. */
export const COMPACTION_WAIT_FAILURE_DETAIL: Readonly<
  Record<Exclude<CompactionWaitTerminal, "observed">, string>
> = {
  not_compacted: "the provider ended the compaction's turn without a compaction frame",
  binding_lost: "the binding stopped being live before a compaction frame arrived",
};

/**
 * The pending compactions of one driver, keyed by the driver's own address for a live binding.
 * The key must name the binding a wait was dispatched under, so a path that replaces the binding
 * can release its stranded waits: a driver keys on session id, or on session id and thread id
 * where a fork re-points the record and a resume installs a new one, releasing the old key at
 * both.
 */
export class PendingCompactionRegistry {
  readonly #waitsByKey: Map<string, Set<RegisteredCompactionWait>> = new Map();

  /**
   * Arms a wait for `key`. Arm before dispatching: a frame delivered between the request resolving
   * and the registration would hit an empty registry and the wait would see no frame.
   * `settled` never rejects.
   */
  arm(key: string): ArmedCompactionWait {
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

      const registration: RegisteredCompactionWait = { settle: settleOnce };

      abandon = (): void => {
        if (closed) {
          return;
        }
        closed = true;
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

  /**
   * The provider ended the turn that ran the compaction on `key`, which delivers its frame before
   * that end: settles every waiter still armed, the frame having not come. A no-op with none.
   */
  observeTurnEnd(key: string): void {
    this.#settleAll(key, { terminal: "not_compacted", boundaryPosition: null });
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
