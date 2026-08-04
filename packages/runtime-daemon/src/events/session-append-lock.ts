// Per-session append mutex — the serialization primitive under the whole
// Plan-006 append path (T3.1).
//
// DEPENDENCY LEAF. This module imports neither of its siblings
// (`event-log-service.ts`, `ingest-halt-source.ts`) — only contracts types. That
// is structural, not stylistic: `IngestHaltRegistry` needs the lock to publish
// its set mutations, and `EventLogService` needs both the lock AND a value-import
// of `NeverHaltedIngestHaltSource`. With the lock at the bottom of the graph
// those edges form a tree; if the lock imported either sibling they would form
// an eager ESM cycle whose module-initialization order decides whether the
// module-singleton state below is initialized before its first reader — a
// failure that reproduces only under some import orders.
//
// ----------------------------------------------------------------------------
// Why a mutex at all
// ----------------------------------------------------------------------------
//
// `session_events` is a HASH CHAIN partitioned by `session_id`: each row's
// `prev_hash` is the previous row's `row_hash`, and its `sequence` is the
// previous row's plus one. Producing a row therefore means READ the chain head,
// then WRITE the successor — and the append path is unavoidably ASYNC between
// those two steps (unsealing the daemon signing key can await a WebAuthn
// ceremony; PII encryption is async). Two concurrent appends on one session
// would both read the same head and both derive the same `(sequence, prev_hash)`
// pair: one loses to `UNIQUE(session_id, sequence)` (a spurious hard failure on
// a legitimate write) and, worse, a chain FORK becomes representable the moment
// any future writer does not hold that unique constraint. better-sqlite3's
// synchronous transactions cannot help — a transaction cannot span an `await`.
//
// Scope is per-SESSION, not global: chains are independent across sessions, so
// serializing them against each other would convert an unrelated session's slow
// key ceremony into head-of-line blocking for every other session.
//
// HONEST LIMIT: this lock is PROCESS-LOCAL. It orders appends within one daemon
// process; it does not order two daemon processes against the same file. That
// residual is covered at the storage layer by `UNIQUE(session_id, sequence)`,
// which turns a cross-process interleave into a loud constraint violation rather
// than a silent fork. Nothing here should be read as a distributed lock.
//
// ----------------------------------------------------------------------------
// Owner-scoped reentrancy, and why a plain mutex would deadlock
// ----------------------------------------------------------------------------
//
// Callers legitimately NEST. Phase 4's key-reuse observer runs its whole
// halt-and-record sequence inside one `withSessionAppendLock` hold and calls
// `IngestHaltRegistry.halt()` from within it — and `halt()` takes the same lock
// to publish its mutation. Producers do the same shape: a `guard-swap-append`
// wrap holds the lock across a read-decide-write and calls `append()` inside it.
// Under a plain mutex every one of those self-deadlocks.
//
// So the hold is carried in an `AsyncLocalStorage` context (`node:async_hooks`)
// keyed by session: a frame running INSIDE a hold on session S reuses that hold
// when it re-enters for S, and any caller OUTSIDE that context blocks until
// release. This is OWNER-scoped, not thread-scoped or global — reentrancy is
// granted by provenance (you are running within the holder's async context), not
// by identity claims a caller could forge.
//
// The store is a MAP of holds, not a single token, because nesting crosses
// sessions: a hold on A that nests an append on B must genuinely ACQUIRE B (B is
// a different chain with its own head), and a further nested append on A must
// still be recognized as reentrant. A boolean or single-session token satisfies
// the one-session reading of the rule and deadlocks on A→B→A.
//
// Each hold carries a `released` flag and a released hold does NOT grant
// reentrancy. That closes the one real soundness hole in ALS-based reentrancy: a
// task SPAWNED inside the critical section but not awaited by it inherits the
// async context and can run AFTER the hold is released, at which point "I am
// inside the holder's context" is no longer evidence that the hold exists. Such
// a straggler falls through and acquires normally.

import { AsyncLocalStorage } from "node:async_hooks";

import type { SessionId } from "@ai-sidekicks/contracts";

/**
 * One live acquisition. Identity (not `sessionId` equality) is what the
 * queue-tail check below compares, and `released` is what keeps a hold from
 * granting reentrancy after it has been given up.
 */
interface SessionAppendLockHold {
  readonly sessionId: SessionId;
  released: boolean;
}

// MODULE-SINGLETON lock state. A per-instance lock would be no lock at all: the
// invariant is "one appender per session per PROCESS", and two service instances
// over the same database file are exactly the case that must serialize.
//
// The value is the queue TAIL — a promise that settles when the last-queued
// waiter releases. Acquiring means: read the tail, publish yourself as the new
// tail (synchronously, before any await, so the chain cannot be raced), then
// await the old tail. Entries are deleted when the queue drains, so a
// long-running daemon does not accumulate one Map entry per session it has ever
// touched.
const sessionAppendQueueTails = new Map<SessionId, Promise<void>>();

// The owner-scoped hold context. Keyed by session so nested cross-session
// acquisition works (see the header).
const heldSessionAppendLocks = new AsyncLocalStorage<
  ReadonlyMap<SessionId, SessionAppendLockHold>
>();

/**
 * Run `critical` under the per-session append mutex.
 *
 * Acquires the lock for `sessionId`, awaits `critical()`, and releases on
 * SETTLE — resolve or reject alike. Reentrant for the owner: if the calling
 * frame is already running inside a live hold on this session, `critical` runs
 * immediately on the existing hold, and that frame neither acquires nor
 * releases. A caller outside the holder's async context always blocks.
 *
 * The rejection contract differs between the two paths, deliberately:
 *
 *   * ACQUIRING frame — a rejecting `critical` releases the hold in a `finally`
 *     and the rejection propagates UNCHANGED. Without the `finally` a single
 *     failed append (a halt refusal, a constraint violation, a key-unseal error)
 *     would wedge that session's chain permanently, converting a recoverable
 *     write failure into a session-lifetime outage. The hold must be released on
 *     the failure path for the same reason it is released on the success path,
 *     and the error must NOT be wrapped: callers branch on typed
 *     `DaemonDomainError` codes, and re-wrapping would erase the discrimination
 *     the whole typed-refusal design exists to provide.
 *
 *   * REENTRANT frame — a rejecting `critical` propagates unchanged and releases
 *     NOTHING, because it acquired nothing. Releasing here would be an
 *     over-release: the OUTER frame still needs the hold (it may well catch this
 *     rejection and continue), and dropping the lock out from under it would let
 *     a waiter interleave into the middle of the outer critical section. Whoever
 *     acquired the hold releases it — nobody else.
 *
 * @param sessionId The chain partition to serialize on. Per-session, so an
 *   unrelated session's slow append never blocks this one.
 * @param critical The critical section. Runs at most once per call.
 */
export async function withSessionAppendLock<T>(
  sessionId: SessionId,
  critical: () => Promise<T>,
): Promise<T> {
  const currentHolds: ReadonlyMap<SessionId, SessionAppendLockHold> | undefined =
    heldSessionAppendLocks.getStore();
  const existingHold: SessionAppendLockHold | undefined = currentHolds?.get(sessionId);

  if (existingHold !== undefined && !existingHold.released) {
    // REENTRANT. Reuse the hold verbatim: no queue interaction, no new store
    // frame (the hold map is already correct for this session), no release. The
    // rejection path is `critical`'s own — this frame adds no `finally`, by
    // design (see the rejection contract above).
    return critical();
  }

  // ACQUIRE. Publish ourselves as the new queue tail BEFORE awaiting the old
  // one. Both statements are synchronous and run in the same tick, so no other
  // caller can observe (or splice into) a half-updated chain.
  const predecessor: Promise<void> = sessionAppendQueueTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const heldUntilRelease: Promise<void> = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionAppendQueueTails.set(sessionId, heldUntilRelease);

  // Wait for our turn. `predecessor` is a release signal, never a carrier of the
  // predecessor's outcome — a predecessor whose `critical` REJECTED still
  // released, and its failure is its own caller's business, not ours. (The
  // promise stored in the map resolves only via `release()`, so there is no
  // rejection to swallow here in the first place.)
  await predecessor;

  const hold: SessionAppendLockHold = { sessionId, released: false };
  const nextHolds = new Map<SessionId, SessionAppendLockHold>(currentHolds);
  nextHolds.set(sessionId, hold);

  try {
    // `run` scopes the hold map to `critical` and everything it awaits. The
    // store teardown is structural — it ends with the run-callback's async
    // context — so the `finally` below executes OUTSIDE the store and cannot
    // leave a stale hold visible to this frame's continuation.
    return await heldSessionAppendLocks.run(nextHolds, critical);
  } finally {
    // Unconditional release-on-settle. Marking the hold released FIRST is what
    // denies reentrancy to any straggler task that inherited this async context
    // but outlived the hold (see the header).
    hold.released = true;
    release();
    // Drain the queue entry when nobody chained behind us. The identity check is
    // the whole correctness argument: a waiter publishes ITS tail synchronously
    // before awaiting ours, so if the tail is still our promise then no waiter
    // exists and a later caller can safely start a fresh chain. If a waiter DID
    // queue, the tail is theirs and we must not delete it — doing so would let
    // the next arrival bypass the queue and hold the session concurrently.
    if (sessionAppendQueueTails.get(sessionId) === heldUntilRelease) {
      sessionAppendQueueTails.delete(sessionId);
    }
  }
}

/**
 * Whether the calling async context is running inside a LIVE hold on ANY
 * session's append lock.
 *
 * This is the same predicate `withSessionAppendLock` consults to grant
 * reentrancy, quantified over every session in the store instead of one. It
 * exists for the callers that must REFUSE to run inside a hold rather than be
 * granted one. Owner-scoped reentrancy is the right default for an APPENDER —
 * without it every nested `append()` self-deadlocks (see the header) — but it is
 * the wrong default for a batch pass that acquires the lock itself, per row,
 * across many sessions: such a pass entered from inside a hold would acquire
 * NOTHING for that session's rows and mutate them outside the serialization the
 * outer hold exists to provide, with no error anywhere. The compactor's `tick()`
 * is the first such caller.
 *
 * ANY-session rather than per-session, deliberately. A pass-scoped caller has no
 * single session in hand when it is entered, and the shape it must reject — a
 * frame holding SOME session's lock invoking something that will acquire locks
 * on its own account — is a property of the async context, not of one partition.
 * A per-session variant would also be the weaker guard here: it would clear a
 * tick entered under a hold on session A even though that tick is about to
 * acquire A among the rest.
 *
 * Released holds report `false`, for the reason the header gives: a straggler
 * task that inherited this context after release holds nothing and would acquire
 * normally, so treating it as a holder would refuse work that is in fact safe.
 */
export function isWithinSessionAppendLockHold(): boolean {
  const currentHolds: ReadonlyMap<SessionId, SessionAppendLockHold> | undefined =
    heldSessionAppendLocks.getStore();
  if (currentHolds === undefined) {
    return false;
  }
  for (const hold of currentHolds.values()) {
    if (!hold.released) {
      return true;
    }
  }
  return false;
}

/**
 * TEST-ONLY. Drop all queued per-session lock state.
 *
 * Not part of the append contract and never called by production code — the
 * name says so, and this doc-comment is the second copy of that statement so a
 * grep for either finds it. Its purpose is isolation between test cases: the
 * lock state is a module singleton, so a case that leaves a session's queue
 * non-empty (an abandoned acquisition, a deliberately un-settled `critical`)
 * would otherwise stall the NEXT case that touches the same session id, and the
 * failure would present as an unrelated timeout.
 *
 * DANGER, and it is real: this does not cancel in-flight critical sections. It
 * forgets the queue, so an append still running keeps running while a fresh
 * caller acquires immediately — two concurrent holders on one session. Calling
 * it while any append is in flight reintroduces exactly the race the lock
 * exists to prevent. Call it between cases, never during one.
 *
 * ALS-scoped holds are deliberately untouched: they live in per-async-context
 * stores, not here, and each dies with its own context.
 */
export function __resetSessionAppendLocksForTest(): void {
  sessionAppendQueueTails.clear();
}
