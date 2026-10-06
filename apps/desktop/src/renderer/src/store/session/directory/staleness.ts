// When the service's session directory is read again. The read is never polled: it repeats when
// something says the answer moved, which is mount, window focus, reconnect (through
// `store/reads/triggers.ts`), or a settled act calling `requestSessionDirectoryRead`. `subscribe`
// is not routed into the revision below because the mount read is the subscribe read.

import type { Unsubscribe } from "#shared/preload-api.js";

import type { SessionDirectoryReadCall } from "./state.js";

/**
 * How many times each call's directory has been declared stale. It counts a fact about the
 * service, not a subject-scoped value or a settlement gate, so it is not a holder or a latch.
 * The `WeakMap` key is the call, so a superseded call takes its count with it.
 */
export class SessionDirectoryStaleness {
  readonly #revisionByCall = new WeakMap<SessionDirectoryReadCall, number>();
  readonly #watchersByCall = new WeakMap<SessionDirectoryReadCall, Set<() => void>>();

  /** How many times this call's directory has been declared stale. Zero until one is. */
  public revisionFor(call: SessionDirectoryReadCall): number {
    return this.#revisionByCall.get(call) ?? 0;
  }

  /** Declare this call's directory stale, and wake every view reading it. */
  public declareStale(call: SessionDirectoryReadCall): void {
    this.#revisionByCall.set(call, this.revisionFor(call) + 1);
    // A copy, so a watcher that releases its handle while woken does not mutate the walked set.
    for (const wake of [...(this.#watchersByCall.get(call) ?? [])]) {
      wake();
    }
  }

  /** Watch one call's revision. The returned handle is terminal for its watcher. */
  public watch(call: SessionDirectoryReadCall, wake: () => void): Unsubscribe {
    const watchers = this.#watchersByCall.get(call) ?? new Set<() => void>();
    watchers.add(wake);
    this.#watchersByCall.set(call, watchers);
    return () => {
      watchers.delete(wake);
    };
  }
}

/**
 * The app's staleness counts, one for the console document and so for every window it draws,
 * advanced by `requestSessionDirectoryRead`.
 */
export const sessionDirectoryStaleness: SessionDirectoryStaleness = new SessionDirectoryStaleness();

/**
 * Ask every view reading the service's directory to read it again. For a settled act whose answer
 * already implies the list changed; it coalesces nothing.
 */
export function requestSessionDirectoryRead(read: SessionDirectoryReadCall): void {
  sessionDirectoryStaleness.declareStale(read);
}
