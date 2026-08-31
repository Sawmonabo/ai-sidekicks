// Plan-005 T3.26 — the pending-compaction wait, shared by both driver legs.
//
// WHY A WAIT EXISTS AT ALL. Both compaction mechanisms answer BEFORE the work is
// done: the Codex request resolves with an empty acknowledgement the moment the
// provider accepts it, and the Claude leg is a command frame that is not answered
// at all. Settling `applied` on either would report a compaction that may never
// happen. The only evidence that admits `applied` is the provider's own typed
// compaction frame — the same frame that normalizes into the boundary row — so
// the operation dispatches, then waits for that frame.
//
// WHY THE WAIT IS TWICE-TERMINATED, AND WHY NEITHER TERMINAL IS A POLL. A wait
// with one terminal is either unbounded (a wedged provider holds the caller
// forever) or bounded only by time (a binding that died two seconds in still
// holds the caller for the whole declared bound). Both terminals are therefore
// registered here:
//
//   1. the driver's DECLARED bound elapses — a timer, scheduled once per waiter;
//   2. the BINDING stops being live — pushed in from the disposal path.
//
// The second is a push and deliberately not a periodic liveness check. A poller
// that woke and asked "is the connection closed" would pass a fake-timer test and
// still fail the property that matters: a binding lost at t=0 must settle at t=0,
// not at the next tick. Every disposal path in a driver already runs code; this
// registry is settled FROM those paths, so the settlement is simultaneous with
// the loss by construction.
//
// BOUNDING THE OPERATION NEVER BOUNDS THE BOUNDARY'S RECORD. A late compaction
// frame that arrives after this wait expired still travels its ordinary route and
// still normalizes into `usage.context_compacted`. `observeBoundary` below is a
// TAP on that route and never a diversion from it: it is called beside the
// hand-off rather than in place of it, so the boundary row is produced whether or
// not anyone is still waiting. That is what makes "the operation failed, and the
// compaction is still recorded" true by construction rather than by convention.
//
// WHY A SET OF WAITERS PER KEY RATHER THAN A SINGLE-FLIGHT REFUSAL. Two
// participants can ask for a compaction on one binding at once, and
// `DriverCompactionResult`'s refusal arm is CLOSED at `command_absent` and
// `not_permitted` — neither of which describes "someone else asked first", and
// widening a closed wire union to describe a driver-internal race would be a
// contract growth this task does not carry. So every waiter for a key settles on
// the same terminal: one provider compaction is one compaction, and both callers
// are told the truth about it.
//
// WHY WITHDRAWAL IS PER-WAITER WHILE SETTLEMENT IS PER-KEY. A dispatch that
// THREW never reached the provider's queue in any way this driver can attest, so
// its caller has nothing left to correlate and returns immediately — but the wait
// it armed one line earlier is still registered, and a registry with no
// withdrawal would hold that registration and its timer for the whole declared
// bound. On a driver whose transport deadline is SHORTER than that bound the
// orphan outlives its caller by the difference, which is why this is a leak and
// not merely untidiness.
//
// The withdrawal is therefore per-waiter and is deliberately NOT a settlement.
// Settlement answers the question "did a compaction happen", so it is per-key —
// one provider compaction is one compaction. Withdrawal answers "is this caller
// still asking", which is a property of one registration and of no other, and a
// caller whose own transport failed must not settle a CONCURRENT participant's
// wait on that failure. Withdrawing therefore removes exactly one registration
// and cancels exactly one timer, and every sibling on the key stays armed for the
// evidence it is still waiting on.
//
// Spec coverage: `Spec-005 §Desktop Console Parity Surfaces`. Refs: Plan-005
// T3.26, I-005-13.

/**
 * How one wait ended.
 *
 * `observed` is the only terminal that admits `applied`; the other two are the
 * two ways of not seeing the evidence, and the caller maps each onto its own
 * `DriverCompactionResult` failure reason.
 */
export type CompactionWaitTerminal = "observed" | "wait_expired" | "binding_lost";

/**
 * The settlement handed back to one waiter.
 *
 * `boundaryPosition` is meaningful ONLY on the `observed` terminal and is `null`
 * on the other two — but it is carried on all three rather than made arm-specific,
 * because the caller's own result type is where that distinction is enforced and
 * a second discriminated union here would be a shape the caller has to re-narrow
 * for no added guarantee. On `observed` the `null` is the positive statement that
 * the provider's frame named no position.
 */
export interface CompactionWaitSettlement {
  readonly terminal: CompactionWaitTerminal;
  readonly boundaryPosition: number | null;
}

/**
 * Schedules a one-shot callback and returns its canceller.
 *
 * Injected rather than closed over `setTimeout` for the reason every timer in
 * this band is: a test that has to wait a real declared bound to observe an
 * expiry is a test nobody runs. Matches the shape the Codex transport already
 * uses for its own deadlines.
 */
export type CompactionWaitScheduler = (callback: () => void, delayMs: number) => () => void;

/**
 * One registered waiter, as the registry's own key-wide paths see it.
 *
 * Carries `settle` alone: the timer canceller and the withdrawal both belong to
 * the ONE caller that armed this wait and are handed back to it on its
 * `ArmedCompactionWait`, never published on the shared registration a key-wide
 * pass iterates. A canceller reachable from `#settleAll` would be an invitation
 * to cancel a sibling's bound from a pass that has no business ending it.
 */
interface RegisteredCompactionWait {
  readonly settle: (settlement: CompactionWaitSettlement) => void;
}

/**
 * One armed wait: the settlement to await, and the withdrawal that ends it.
 *
 * `settled` NEVER SETTLES AFTER `abandon()`, and that is the deliberate shape
 * rather than an oversight. The alternatives were each worse: resolving with a
 * fourth `abandoned` terminal would widen a union whose only reader is a caller
 * that has already returned, forcing a dead arm into both drivers' exhaustive
 * mappers; and resolving with one of the three real terminals would report a
 * binding loss or an elapsed bound that did not happen. A withdrawn registration
 * has no waiter, so there is nothing to tell.
 *
 * The hazard that shape carries is named rather than hidden: a caller that
 * abandons and THEN awaits `settled` waits forever. Both call sites reach the two
 * on mutually exclusive branches — abandon on the dispatch-failed arm, await on
 * the dispatch-succeeded one — which is the discipline this handle exists to make
 * explicit, since a bare promise offered no place to state it.
 */
export interface ArmedCompactionWait {
  /** Resolves on the wait's terminal; never rejects, never settles once withdrawn. */
  readonly settled: Promise<CompactionWaitSettlement>;
  /**
   * Withdraw this waiter: cancel its bound's timer and forget its registration.
   *
   * Idempotent, and safe to call after the wait has already settled — a wait that
   * settled on evidence has cancelled its own timer and forgotten itself already,
   * so the second call finds nothing to do. Touches no sibling waiter on the key.
   */
  abandon(): void;
}

/**
 * The pending compactions of one driver, keyed by whatever that driver uses to
 * address a live binding (both shipped drivers use their session id).
 *
 * Holds no provider state and performs no I/O: it is the correlation between a
 * dispatched compaction and the frame that proves it landed, and nothing else.
 */
export class PendingCompactionRegistry {
  readonly #waitsByKey: Map<string, Set<RegisteredCompactionWait>> = new Map();
  readonly #scheduleTimeout: CompactionWaitScheduler;

  constructor(scheduleTimeout: CompactionWaitScheduler) {
    this.#scheduleTimeout = scheduleTimeout;
  }

  /**
   * Arm a wait for `key` and hand back the promise its terminal settles.
   *
   * ARMED BEFORE THE DISPATCH, never after: a provider fast enough to compact
   * between the request resolving and the wait being registered would otherwise
   * deliver its boundary frame to an empty registry, and the caller would then
   * wait out the full bound for evidence that had already arrived. The window is
   * small and real, and closing it costs one ordering rule.
   *
   * `settled` NEVER REJECTS. Every terminal is a settlement the caller maps onto a
   * result arm, and a rejection would make the wait's own bookkeeping
   * indistinguishable from the provider mechanism failing.
   *
   * The returned handle carries `abandon()` for the caller whose dispatch threw:
   * see the withdrawal doctrine in this module's header for why that withdrawal
   * is per-waiter while every settlement is per-key.
   */
  arm(key: string, boundMs: number): ArmedCompactionWait {
    // Captured out of the executor rather than composed around it because the
    // withdrawal and the settlement share ONE `closed` flag: two flags, or a
    // withdrawal written in terms of the public surface, would let a timer that
    // fired between them resolve a promise its caller had already walked away
    // from. The executor runs synchronously, so the binding is assigned before
    // `arm` returns. (Idiom shared with `events/session-append-lock.ts`.)
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
        // CLOSED FIRST, cancelled second. The flag is what makes the withdrawal
        // total: a scheduler whose canceller does not really stop its timer —
        // every injected test double, and any host whose clear raced the fire —
        // would otherwise deliver `wait_expired` into a promise whose caller had
        // withdrawn, and `settled` would settle after all.
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

  /**
   * A typed compaction frame was observed on `key` — settle every waiter on it.
   *
   * A TAP: the caller invokes this beside the frame's ordinary hand-off, never
   * instead of it, so the boundary still projects when nobody is waiting. Calling
   * it with no armed waiter is the ordinary case (a provider-initiated compaction
   * nobody asked for) and is deliberately a silent no-op rather than a diagnostic
   * — there is nothing wrong with a compaction the participant did not trigger.
   */
  observeBoundary(key: string, boundaryPosition: number | null): void {
    this.#settleAll(key, { terminal: "observed", boundaryPosition });
  }

  /**
   * The binding behind `key` is no longer live — settle every waiter immediately.
   *
   * Called from the driver's disposal paths (graceful teardown and quarantine
   * alike), which is what makes the settlement simultaneous with the loss rather
   * than merely eventual. Idempotent: a teardown that runs after a quarantine
   * already settled the waiters finds an empty set and does nothing.
   */
  releaseBinding(key: string): void {
    this.#settleAll(key, { terminal: "binding_lost", boundaryPosition: null });
  }

  /** How many waits are armed for `key` — for the driver's own assertions. */
  pendingCountFor(key: string): number {
    return this.#waitsByKey.get(key)?.size ?? 0;
  }

  #settleAll(key: string, settlement: CompactionWaitSettlement): void {
    const waits = this.#waitsByKey.get(key);
    if (waits === undefined) {
      return;
    }
    // Snapshotted before iterating: each `settle` deletes its own registration
    // from this very set, and mutating a Set under its own iteration is exactly
    // the shape that silently skips entries.
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
      // The key's entry goes with its last waiter so a long-lived driver does not
      // accumulate one empty Set per session it ever compacted.
      this.#waitsByKey.delete(key);
    }
  }
}
