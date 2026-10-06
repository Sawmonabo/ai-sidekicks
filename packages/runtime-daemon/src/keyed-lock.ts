// A reentrant lock per key: callers on one key run one at a time in arrival order, callers on
// different keys never wait for each other.
//
// - Callers nest: a caller holding key K that calls code taking K again runs that code on its own
//   hold. A plain mutex would deadlock, so the holds ride in an `AsyncLocalStorage` context: a
//   frame inside a hold on K reuses it, and a caller outside that context waits.
// - The context holds a map of holds, not one token, because nesting crosses keys: a hold on A
//   that nests a hold on B must acquire B, and a further nested call on A must still reenter.
// - A hold is marked released when it ends, and a released hold grants no reentrancy: a task
//   started inside the hold but not awaited by it inherits the context and may run after release,
//   so it acquires normally.
// - Each key's queue is the promise of its last waiter, deleted once the queue drains, so the map
//   never grows with every key ever locked.

import { AsyncLocalStorage } from "node:async_hooks";

// One live acquisition; compared by identity, and `isReleased` ends its reentrancy.
interface KeyedLockHold {
  isReleased: boolean;
}

/** A per-key, reentrant, first-come-first-served lock held across awaits. */
export class KeyedLock<Key> {
  readonly #canonicalKey: (key: Key) => Key;
  // Each key's queue tail: settles when its last waiter releases.
  readonly #queueTails = new Map<Key, Promise<void>>();
  readonly #holds = new AsyncLocalStorage<ReadonlyMap<Key, KeyedLockHold>>();

  /** `canonicalKey` maps every spelling of one key to one value, so one key takes one lock. */
  constructor(canonicalKey: (key: Key) => Key = (key) => key) {
    this.#canonicalKey = canonicalKey;
  }

  /**
   * Runs `critical` holding `requestedKey` and releases it when `critical` settles, either way; a
   * rejection propagates unchanged. Inside a live hold on the same key, runs `critical` on it.
   */
  async run<T>(requestedKey: Key, critical: () => Promise<T>): Promise<T> {
    const key = this.#canonicalKey(requestedKey);
    const currentHolds = this.#holds.getStore();
    const existingHold = currentHolds?.get(key);
    if (existingHold !== undefined && !existingHold.isReleased) {
      // The outer frame still owns the hold, so this frame neither queues nor releases.
      return critical();
    }

    // Becoming the tail and reading the old one happen in one turn, so no caller sees a half-made
    // queue.
    const predecessor = this.#queueTails.get(key) ?? Promise.resolve();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    this.#queueTails.set(key, released);
    await predecessor;

    const hold: KeyedLockHold = { isReleased: false };
    const nextHolds = new Map(currentHolds);
    nextHolds.set(key, hold);
    try {
      return await this.#holds.run(nextHolds, critical);
    } finally {
      hold.isReleased = true;
      release();
      // Another tail means a waiter queued behind this hold, and deleting it would let the next
      // caller jump the queue.
      if (this.#queueTails.get(key) === released) {
        this.#queueTails.delete(key);
      }
    }
  }

  /** Whether the calling async context is inside a live hold on any key of this lock. */
  isHeldHere(): boolean {
    for (const hold of this.#holds.getStore()?.values() ?? []) {
      if (!hold.isReleased) {
        return true;
      }
    }
    return false;
  }
}
