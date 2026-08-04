// Ingest-halt seam — the administrative "stop accepting writes for this session"
// switch the append path consults (Plan-006 T3.1, F-006-HALT-*).
//
// ----------------------------------------------------------------------------
// What halts ingest, and why the read side must be trivial
// ----------------------------------------------------------------------------
//
// Phase 4's key-reuse observer detects a daemon signing key appearing under more
// than one identity — the `refuse_on_rotation` Sigstore-precedent violation of
// I-006-4-03. A key in that state can no longer attest anything: every row it
// signs is repudiable, because a second holder could have produced it. The
// correct response is to STOP APPENDING on every locally-hosted identity the
// colliding key appears under, and to keep refusing until the collision leaves
// the observable set. That refusal is what this seam publishes.
//
// The READ side (`isHalted`) is deliberately the narrowest possible surface:
// synchronous, no I/O, no lock. It is consulted on EVERY append, first, while
// the append lock is held — so anything slower would put an I/O round-trip (and,
// if it took a lock, a deadlock hazard) on the hot path of every write in the
// daemon. A `Set` membership test is the whole implementation.
//
// The WRITE side is separated into `IngestHaltRegistry` rather than folded into
// the same interface, because the two have opposite consumer sets: everything
// that APPENDS depends on the read side, and exactly one component (the T4.2
// observer) publishes. Keeping `IngestHaltSource` read-only means
// `EventLogService` cannot halt a session even by accident, and a test double is
// one method.
//
// ----------------------------------------------------------------------------
// Construction order, and the cycle it breaks
// ----------------------------------------------------------------------------
//
// The registry has ZERO constructor dependencies. That is what makes the
// three-way wiring acyclic:
//
//     registry  →  EventLogService(registry as IngestHaltSource)  →  observer
//
// The observer needs the service (it appends `key_reuse_detected`) and needs to
// halt; the service needs a halt source. Were the registry to take the service
// (say, to append its own audit row on halt), the graph would close into
// observer ↔ service with no valid construction order. It does not, so it does
// not.
//
// The registry deliberately mints NO cancellation API. Phase 4's sweep-generation
// cancellation works by a different route: the observer already holds
// `withSessionAppendLock` for the session, and its nested `registry.halt()` call
// REUSES that hold through owner-scoped reentrancy, so the halt publication is
// inside the observer's own critical section and is ordered with its other work
// by construction. A cancellation token here would be a second, weaker mechanism
// for something the lock already provides.
//
// That reentrancy is NOT an unmixed benefit, and reading it as one is what hid a
// fail-open bug through a review round. A reentrant `halt()` does not queue: it
// runs AHEAD of everything already waiting on the session's lock, including a
// `clear()` that queued before the observer took its hold. So "the lock's FIFO
// ordering makes the later administrative decision win" — true for an ordinary
// caller — does not hold for the caller this header holds up as the intended
// one. That is why the registry also carries a per-session halt GENERATION
// counter (see `halt` and `clear`): on the reentrant path it is the counter, not
// the lock's ordering, that makes the halt stick.

import { DAEMON_SCOPE_SENTINEL_SESSION_ID, type SessionId } from "@ai-sidekicks/contracts";

import { withSessionAppendLock } from "./session-append-lock.js";

/**
 * The READ side of the ingest-halt seam — the only part `EventLogService`
 * depends on.
 *
 * Implementations MUST NOT admit `DAEMON_SCOPE_SENTINEL_SESSION_ID` into their
 * halted set. "Halt the node-scope chain" is not a coherent operation: the
 * sentinel partition carries daemon-scope rows that describe the machine itself,
 * including the audit-integrity events that RECORD a halt. Halting it would
 * silence the alarm system as a side effect of raising an alarm.
 */
export interface IngestHaltSource {
  /**
   * Is this session's ingest administratively halted?
   *
   * SYNCHRONOUS, no I/O, no lock — see the file header. Called on the hot path
   * of every append, under the append lock. An implementation that blocks, does
   * I/O, or acquires a lock here breaks the append path rather than extending
   * it.
   */
  isHalted(sessionId: SessionId): boolean;
}

/**
 * The vacuous `IngestHaltSource`: nothing is ever halted.
 *
 * This is the DEFAULT the append service falls back to when no registry is
 * wired, and the choice of default is a security judgement worth stating.
 * Fail-OPEN is correct here specifically: halting is an exceptional,
 * externally-published state, and a daemon with no key-reuse observer running
 * (every deployment before Phase 4 lands, plus every unit test of an unrelated
 * append behaviour) has no evidence any session is compromised. A fail-CLOSED
 * default would refuse every write in that configuration — turning "the observer
 * is not wired" into "the daemon cannot record anything", including the events
 * an operator would need to diagnose it.
 *
 * Deliberately a class with a shared instance rather than an object literal, so
 * `instanceof` identifies the vacuous case in a diagnostic and so the type is
 * nameable at a wiring seam.
 */
export class NeverHaltedIngestHaltSource implements IngestHaltSource {
  /**
   * Always `false`. Not `sessionId`-dependent, which is the point: this
   * implementation admits nothing to a halted set because it has no set.
   */
  isHalted(_sessionId: SessionId): boolean {
    return false;
  }
}

/**
 * The WRITE side — the in-memory halted-session registry the T4.2 key-reuse
 * observer publishes to, and the `IngestHaltSource` the append service reads.
 *
 * THE GUARANTEE CALLERS CODE AGAINST: when `await halt(S)` resolves,
 * `isHalted(S)` is true and no `clear(S)` already in flight can still undo it —
 * INCLUDING when the caller holds `S`'s append lock and the halt therefore runs
 * reentrantly, which is the T4.2 observer's own pattern. The observer halts on a
 * key-reuse observation and then proceeds believing ingest is stopped, so this
 * guarantee is the whole point of the seam rather than a nicety. Two mechanisms
 * together produce it — `#pendingClears` and `#haltGenerations` — and neither
 * alone is sufficient; `halt`'s doc comment names the interleaving each closes.
 *
 * State is PROCESS-LOCAL and deliberately not durable. A halt is a live
 * response to a live observation: on daemon restart the observer re-derives the
 * key-collision set from the key stores and re-publishes, so persisting the set
 * would add a way for a STALE halt to survive the evidence that justified it —
 * a session refusing writes forever because of a collision that was resolved
 * while the daemon was down.
 */
export class IngestHaltRegistry implements IngestHaltSource {
  // Zero constructor dependencies (see the file header's construction-order
  // argument). The set is the authoritative halted state.
  readonly #haltedSessionIds = new Set<SessionId>();

  // In-flight `clear()` calls per session — incremented BEFORE that call
  // acquires the append lock and decremented when it settles. This exists for
  // exactly one reason: it is what makes `halt()`'s pre-lock fast path safe
  // against a QUEUED clear. See the ordering rationale on `halt()`.
  //
  // A count, not a boolean: two concurrent `clear()` calls on one session are
  // legal (the reconciler and an operator-initiated re-admission can overlap),
  // and a boolean would let the first to settle clear the flag while the second
  // is still queued, reopening the window this closes.
  readonly #pendingClears = new Map<SessionId, number>();

  // Monotonic per-session HALT GENERATION, bumped by every `halt()` that reaches
  // its mutating path. `clear()` captures it before registering its pendency and
  // re-reads it inside its critical section; a clear whose captured generation
  // was overtaken skips its delete. This is what makes a REENTRANT `halt()`
  // stick, where lock ordering cannot — see `halt`'s Mechanism 2.
  readonly #haltGenerations = new Map<SessionId, number>();

  /**
   * Is this session's ingest halted? Synchronous `Set` membership — no I/O, no
   * lock, per the `IngestHaltSource` contract.
   *
   * The read path takes NO lock even though the write paths do. That is not an
   * oversight: it is called from INSIDE the append lock, so taking it again
   * would rely on reentrancy for correctness rather than for convenience, and
   * `Set.has` against single-threaded JS is already atomic with respect to the
   * `add`/`delete` the write paths perform.
   */
  isHalted(sessionId: SessionId): boolean {
    return this.#haltedSessionIds.has(sessionId);
  }

  /**
   * Halt ingest for `sessionId`. Idempotent.
   *
   * THE PROPERTY THIS METHOD OWES ITS CALLER: when the returned promise
   * resolves, `isHalted(sessionId)` is true and no `clear()` already in flight
   * can still undo it. A resolved `halt()` that leaves the session admitting
   * writes is fail-OPEN on a security gate — the T4.2 observer halts on a
   * key-reuse OBSERVATION and then proceeds believing ingest is stopped — and
   * "the next reconciler tick fixes it" is not an answer, because the window is
   * unbounded by a parked append and the tick is not synchronous with the
   * caller's decision. Two DIFFERENT interleavings threaten that property, and
   * two separate mechanisms are needed; neither alone is sufficient.
   *
   * ORDERING (F-006-HALT-07) — the already-halted no-op is decided BEFORE lock
   * acquisition, and this asymmetry with `clear()` is deliberate. The reconciler
   * tick re-issues `halt()` for every session still in the collision set on
   * every pass; those re-issues are the common case by a wide margin. Deciding
   * the no-op pre-lock means a re-issue never queues behind an in-flight append
   * — which matters because an append can PARK for a long time (a signing-key
   * unseal may await a WebAuthn ceremony), and serializing the reconciliation
   * tick behind a parked append would stall halt publication for every other
   * session in the same tick.
   *
   * MECHANISM 1 — `#pendingClears`, which makes the fast path SAFE TO TAKE.
   * Membership alone is NOT a sound fast-path predicate, and the earlier claim
   * that a racing `clear()` is "indistinguishable to every observer" was false
   * in one direction. The losing interleaving:
   *
   *   1. S is halted. An append for S is parked mid-critical-section in a
   *      signing-key unseal, holding the append lock.
   *   2. `clear(S)` is called; it queues on that lock.
   *   3. `halt(S)` is called AFTER it, sees S in the set, and returns as a
   *      pre-lock no-op.
   *   4. The append releases; `clear(S)`'s critical section runs and deletes S.
   *
   * So the fast path is taken only when S is halted AND no `clear(S)` is in
   * flight. That is what gets a halt racing a queued clear onto the MUTATING
   * path at all; without it the halt returns having never had the chance to
   * re-establish itself.
   *
   * MECHANISM 2 — `#haltGenerations`, which makes that mutation STICK. Reaching
   * the mutating path is not enough, because the mutation is not always ordered
   * AFTER the clear it races. For an ordinary caller it is: the clear queued
   * first, FIFO runs clear then halt, and the later decision wins. For a
   * REENTRANT caller it is not — and reentrancy is the pattern this file's
   * header names as the intended one:
   *
   *   1. S is halted. `clear(S)` registers its pendency and queues behind the
   *      T4.2 observer, which holds S's append lock.
   *   2. The observer calls `halt(S)` from inside its critical section. The
   *      fast path correctly refuses (a clear is pending) — and then the lock
   *      acquisition is REENTRANT, so the `add` runs immediately, ahead of the
   *      queued clear, and never queues.
   *   3. The observer releases; `clear(S)`'s critical section runs and deletes S.
   *
   * Same fail-open, reached on the intended path, and the remedy Mechanism 1
   * prescribes — queue behind the clear — is structurally UNAVAILABLE to a
   * reentrant caller. So the mutating path also BUMPS a monotonic per-session
   * generation, and `clear()` skips its delete when the generation it captured
   * before registering its pendency has been overtaken. Ordering then stops
   * mattering: the halt wins because it advanced the counter, whether it ran
   * before or after the clear's critical section.
   *
   * F-006-HALT-07 is untouched by all of this. The fast-path predicate is
   * unchanged, and the case that argument is about — the reconciler re-issuing
   * `halt()` for a session still in the collision set — has no pending clear by
   * construction (nothing is re-admitting a session that is still colliding), so
   * those re-issues still take the fast path and still never queue behind a
   * parked append.
   *
   * The MUTATING path does take the lock, so the set change is published inside
   * the same critical section appends run in: an append either sees the halt or
   * completes before it, never straddles it.
   */
  async halt(sessionId: SessionId): Promise<void> {
    // Sentinel refusal BEFORE anything else — before the membership check and
    // before any lock acquisition. Fail LOUD rather than silently no-op: a
    // caller trying to halt the node-scope chain has a logic error (the sentinel
    // partition is not a session and has no ingest to stop), and swallowing it
    // would leave that caller believing a halt took effect. Throwing here also
    // keeps the "no implementation ever admits the sentinel into its halted set"
    // property structural rather than conventional.
    assertNotDaemonScopeSentinel(sessionId, "halt");

    // Pre-lock no-op — guarded on BOTH conjuncts (see the ordering rationale).
    // Already-halted is not sufficient: a queued `clear()` would undo this
    // no-op after it returned.
    if (this.#haltedSessionIds.has(sessionId) && (this.#pendingClears.get(sessionId) ?? 0) === 0) {
      return;
    }

    await withSessionAppendLock(sessionId, async () => {
      // No re-check: `add` on an existing member is already the idempotent
      // no-op, so a racer that halted this session between the pre-lock test
      // and acquisition costs a redundant `add` and nothing else. Reaching here
      // via the pending-clear branch is the POINT — this re-establishes the
      // halt whether the clear ran first (FIFO) or has not run yet (reentrant).
      this.#haltedSessionIds.add(sessionId);

      // The generation bump, by contrast, is NEVER redundant and runs
      // unconditionally: reaching this region at all means some caller asked for
      // a halt here, and any `clear()` whose decision predates that ask is
      // superseded by it — including one that has not reached its own critical
      // section yet. Bumping on a no-op `add` is harmless, since the only thing
      // a bump can do is make an ALREADY-SUPERSEDED clear skip its delete.
      this.#haltGenerations.set(sessionId, (this.#haltGenerations.get(sessionId) ?? 0) + 1);
    });
  }

  /**
   * Re-admit ingest for `sessionId`. Idempotent.
   *
   * ORDERING (F-006-HALT-07) — the never-halted no-op is decided AFTER lock
   * acquisition, the mirror image of `halt()`. `clear()` is the RE-ADMISSION
   * decision: it declares that the collision has left the observable set and
   * writes may resume. Deciding that pre-lock would let it interleave with an
   * append that is mid-flight under a halt — the append could pass its
   * halt-gate check against a set this call is concurrently mutating, and the
   * resulting row's admissibility would depend on scheduling. Re-admission is
   * rare (once per resolved collision, versus per-tick re-issues on the halt
   * side), so the cost of always acquiring is negligible and the ordering
   * guarantee is worth strictly more here than the fast path would be.
   *
   * PUBLISHING ITS OWN PENDENCY is the other half of the job, and it happens
   * BEFORE acquisition rather than inside the critical section. A queued
   * `clear()` is invisible to `halt()`'s pre-lock membership test — it has not
   * mutated the set yet and may not for an unbounded time — so without this
   * counter a later `halt()` no-ops and is then silently undone (see the losing
   * interleaving spelled out on `halt()`). The increment must precede the
   * `await`, and the decrement must be in a `finally`: a `clear()` that REJECTS
   * (the sentinel path throws earlier, but the lock itself can propagate a
   * rejection) would otherwise leave a permanent phantom pendency, forcing every
   * future `halt()` for that session onto the slow path forever.
   *
   * DEFERRING TO A HALT THAT EXECUTED LATER is the third obligation, and it is
   * what makes a REENTRANT `halt()` stick (see `halt`'s Mechanism 2). This call
   * captures the session's halt generation BEFORE its first `await` —
   * synchronously, in the same uninterrupted region that publishes the pendency
   * — and re-reads it inside the critical section. A generation that MOVED means
   * some `halt()` EXECUTED its mutating path after this call captured.
   *
   * MIND THE AXIS: the counter records EXECUTION, not DECISION. A moved
   * generation can equally mean a halt decided EARLIER that merely happened to
   * execute after the capture. The mechanism does not distinguish the two and is
   * not meant to — it is deliberately conservative in the fail-CLOSED direction.
   * The comparison is `!==` rather than `>` for the same reason: the counter
   * cannot go backwards while a clear is in flight (see the drain rule below),
   * and should that invariant ever be broken, strict inequality still fails
   * toward "stay halted".
   *
   * RESIDUAL, scoped and deliberate — a `clear()` SUPERSEDED BY A HALT that
   * executed after its capture skips its delete, even where the caller issued
   * the clear later. That is a CLASS, not one shape, and it does not require
   * reentrancy:
   *
   *   * NON-REENTRANT. S is halted at generation 1. `clear1` captures 1 and
   *     queues behind a parked append; `halt` queues behind `clear1`; `clear2`
   *     issues and also captures 1. FIFO runs `clear1`'s delete, then `halt`'s
   *     add + bump to 2, then `clear2` — which sees 2 ≠ 1 and skips. The
   *     earlier-ISSUED halt beats the later-issued `clear2`, no reentrancy
   *     anywhere.
   *   * REENTRANT. A `clear()` issued from inside a held lock runs ahead of a
   *     `halt()` that queued earlier, and that halt then re-adds the session.
   *
   * Both fail CLOSED — a session stays halted that someone asked to re-admit —
   * where the interleaving Mechanism 2 closes fails OPEN on a security gate.
   * Neither can wedge: the next `clear()` captures the post-bump generation and
   * proceeds normally. The contract a Phase-4 reconciler author must read off
   * this is the ASYMMETRY: a resolved `halt()` guarantees the session is halted;
   * a resolved `clear()` does NOT guarantee re-admission. Closing that would
   * take a second, symmetric counter and a second set of interleavings to
   * verify, to chase a hazard in the safe direction, so it is recorded here
   * rather than fixed — and it is vacuous today in any case, since no production
   * consumer of this registry exists yet, T4.2's key-reuse observer being the
   * first.
   */
  async clear(sessionId: SessionId): Promise<void> {
    // Same fail-loud sentinel refusal as `halt`, and for the same reason: the
    // sentinel is never in the set, so a `clear` on it could only be a no-op
    // that misleads its caller. Before any lock acquisition — and before the
    // pendency is published, so a refused `clear` never registers one.
    assertNotDaemonScopeSentinel(sessionId, "clear");

    // CAPTURE BEFORE PUBLISH, and both before the first `await`. Nothing may be
    // interposed between these two statements: the drain rule below relies on
    // "holds a captured generation" implying "is counted in `#pendingClears`",
    // and an `await` between them would break exactly that.
    const capturedHaltGeneration: number = this.#haltGenerations.get(sessionId) ?? 0;
    this.#pendingClears.set(sessionId, (this.#pendingClears.get(sessionId) ?? 0) + 1);
    try {
      await withSessionAppendLock(sessionId, async () => {
        // STALE-GENERATION CHECK — a `halt()` newer than this call's decision
        // ran while it waited (or, on the reentrant path, ran ahead of it
        // despite queueing later). The later administrative decision is the
        // halt, so skip the delete and leave the session halted.
        if ((this.#haltGenerations.get(sessionId) ?? 0) !== capturedHaltGeneration) {
          return;
        }

        // The never-halted no-op is decided HERE, under the lock — `delete` on
        // an absent member returns false and changes nothing, which is exactly
        // the no-op, evaluated in the ordered region rather than ahead of it.
        this.#haltedSessionIds.delete(sessionId);
      });
    } finally {
      // Drain the key at zero rather than leaving a `0` entry: the map would
      // otherwise grow one entry per session ever cleared, for the lifetime of
      // the process, on a registry whose whole state is meant to be small and
      // live.
      const remaining: number = (this.#pendingClears.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.#pendingClears.set(sessionId, remaining);
      } else {
        this.#pendingClears.delete(sessionId);

        // GENERATION DRAIN RULE. Rest state for a session is "no clear in
        // flight AND not halted" — reached here, and only here, because `halt()`
        // never returns a session to rest. Dropping the entry resets the session
        // to an implicit generation 0, which is safe precisely because capture
        // and pendency-publish are adjacent: any clear still holding a captured
        // value is still counted, so `remaining === 0` means nobody holds one
        // and the reset cannot strand a comparison. Outside rest state the map
        // is bounded by |halted sessions| + |in-flight clears|.
        //
        // The still-halted RETENTION guard below is DEFENCE IN DEPTH, and worth
        // being honest about rather than overclaiming: no false-equality
        // construction needs it today. Absent reads as 0; a bump from absent
        // yields 1, never the 0 a fresh capture would read; a bump always
        // accompanies an `add`; and a `halt()` concurrent with a captured value
        // can never take the fast path, because the pendency is ≥ 1 by then.
        // Removing the guard would therefore not reopen a known hazard. It stays
        // because it costs one `Set.has` and because it keeps the stated
        // invariant — "a generation entry exists exactly while the session is
        // halted or being cleared" — true BY CONSTRUCTION rather than by that
        // four-step argument, which is exactly what a future edit to the
        // capture/publish adjacency would silently invalidate.
        if (!this.#haltedSessionIds.has(sessionId)) {
          this.#haltGenerations.delete(sessionId);
        }
      }
    }
  }
}

/**
 * Refuse the node-scope sentinel on a halt-registry WRITE path.
 *
 * A plain `Error`, NOT a `DaemonDomainError`: this is an internal programming
 * error on a daemon-internal seam, not a refusal any remote caller can provoke
 * or should see a typed wire code for. The registry's write methods are reached
 * only from daemon-resident components (the T4.2 observer and its tests), so
 * there is no wire boundary to render a typed error onto.
 */
function assertNotDaemonScopeSentinel(sessionId: SessionId, operation: string): void {
  if (sessionId === DAEMON_SCOPE_SENTINEL_SESSION_ID) {
    throw new Error(
      `IngestHaltRegistry.${operation} refuses the daemon-scope sentinel session ` +
        `(${DAEMON_SCOPE_SENTINEL_SESSION_ID}): the node-scope chain carries daemon-scope ` +
        `rows including the audit-integrity events that record a halt, so halting it would ` +
        `silence the alarm system. Halt the affected session ids instead.`,
    );
  }
}
