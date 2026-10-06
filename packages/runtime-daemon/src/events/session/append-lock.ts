// Per-session append mutex: lets a caller read, decide and append as one step on a session.
// Imports only contracts, never its consumers, so the module graph stays a tree and the
// module-level state below cannot be read before it is initialized.
//
// - `append()` reads the head and writes the row with no await between, so two appends alone
//   cannot derive one `sequence`. The lock is for a caller whose decision spans awaits, such as
//   a terminal run event's check, state swap and append: a better-sqlite3 transaction cannot span
//   an `await`, so the hold keeps any other append on that session waiting until the caller has
//   written. The purge takes it too, so it never deletes between such a caller's read and write.
// - The scope is one session, so a long hold on one session never blocks another.
// - The lock is process-local. Two daemon processes on one database file are caught only by the
//   unique constraint, which fails loudly instead of duplicating a sequence.
// - Callers nest: a producer holds the lock across its read-decide-write and calls `append()`
//   inside, which takes the same lock. A plain mutex would deadlock, so the hold is carried in an
//   `AsyncLocalStorage` context: a frame running inside a hold on session S reuses it for S, and
//   any caller outside that context waits.
// - The context holds a map of holds, not one token, because nesting crosses sessions: a hold on A
//   that nests an append on B must acquire B, and a further nested append on A must still
//   reenter. A single-session token deadlocks on A, B, A.
// - A hold is marked `released` when it ends, and a released hold grants no reentrancy. A task
//   spawned inside the critical section but not awaited by it inherits the context and can run
//   after release; it must acquire normally.

import { AsyncLocalStorage } from "node:async_hooks";

import { canonicalizeUuid } from "@ai-sidekicks/contracts/uuid-canonical";
import type { SessionId } from "@ai-sidekicks/contracts/session/id";

/**
 * One live acquisition. The queue-tail check compares holds by identity, and `released` stops a
 * finished hold from granting reentrancy.
 */
interface SessionAppendLockHold {
  readonly sessionId: SessionId;
  released: boolean;
}

// Module-level on purpose: two service instances over one database file must serialize against
// each other. The value is the queue tail, a promise that settles when the last-queued waiter
// releases. Entries are deleted when the queue drains so the map does not grow with every session
// ever touched.
const sessionAppendQueueTails = new Map<SessionId, Promise<void>>();

// The holds of the current async context, keyed by session so nested cross-session acquisition
// works.
const heldSessionAppendLocks = new AsyncLocalStorage<
  ReadonlyMap<SessionId, SessionAppendLockHold>
>();

/**
 * Runs `critical` under the append mutex for one session and releases it when `critical` settles,
 * whether it resolves or rejects. A rejection propagates unchanged, because callers branch on
 * typed `DaemonDomainError` codes. A caller already inside a live hold on this session runs
 * `critical` on that hold, and neither acquires nor releases it; a caller outside the holder's
 * async context waits.
 */
export async function withSessionAppendLock<T>(
  requestedSessionId: SessionId,
  critical: () => Promise<T>,
): Promise<T> {
  // UUID hex is case-insensitive and the branded schema accepts either case, so without
  // canonicalizing one session spelled two ways would take two locks.
  const sessionId: SessionId = canonicalizeUuid(requestedSessionId);
  const currentHolds: ReadonlyMap<SessionId, SessionAppendLockHold> | undefined =
    heldSessionAppendLocks.getStore();
  const existingHold: SessionAppendLockHold | undefined = currentHolds?.get(sessionId);

  if (existingHold !== undefined && !existingHold.released) {
    // Reentrant: no queue interaction and no release. The outer frame still needs the hold, so a
    // rejection here must not release it.
    return critical();
  }

  // Publish this call as the queue tail before awaiting the old tail. Both steps run in one tick,
  // so no other caller sees a half-updated chain.
  const predecessor: Promise<void> = sessionAppendQueueTails.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const heldUntilRelease: Promise<void> = new Promise<void>((resolve) => {
    release = resolve;
  });
  sessionAppendQueueTails.set(sessionId, heldUntilRelease);

  // The predecessor's promise only signals release; it never carries the predecessor's outcome.
  await predecessor;

  const hold: SessionAppendLockHold = { sessionId, released: false };
  const nextHolds = new Map<SessionId, SessionAppendLockHold>(currentHolds);
  nextHolds.set(sessionId, hold);

  try {
    return await heldSessionAppendLocks.run(nextHolds, critical);
  } finally {
    // Mark the hold released first so a straggler task that inherited this context cannot reenter.
    hold.released = true;
    release();
    // Delete the queue entry only if it is still ours. A waiter publishes its own tail before
    // awaiting ours, so a different tail means someone is queued and deleting it would let the
    // next arrival bypass the queue.
    if (sessionAppendQueueTails.get(sessionId) === heldUntilRelease) {
      sessionAppendQueueTails.delete(sessionId);
    }
  }
}

/**
 * Whether the calling async context is inside a live hold on any session's append lock. For batch
 * passes that take the lock per row across many sessions: entered from inside a hold, such a pass
 * would reenter it and mutate that session's rows outside the serialization the hold provides, so
 * it refuses to run instead. A released hold reports `false`.
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
