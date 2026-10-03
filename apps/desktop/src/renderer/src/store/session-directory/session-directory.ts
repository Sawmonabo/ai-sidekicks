// The sessions on the service, as a view can know them. The service's directory is a different
// question from the set this window has open (`useOpenSessionIds`): a service with six sessions
// and a window that opened none is not empty.
//
// The read is never polled. It repeats when something says the answer moved: mount, window
// focus, reconnect (through `store/reads/read-triggers.ts`), or a settled act calling
// `requestSessionDirectoryRead`. `subscribe` is not routed into the revision below because the
// mount read is the subscribe read.
import type { Unsubscribe } from "@shared/preload-api.js";

/** One session the service lists. A session with no title is shown by its identifier. */
export interface SessionDirectoryEntry {
  readonly sessionId: string;
  readonly title?: string;
  readonly state: string;
}

/** The call that lists the service's sessions. */
export type SessionDirectoryReadCall = (
  signal: AbortSignal,
) => Promise<readonly SessionDirectoryEntry[]>;

/**
 * What a view knows about the service's sessions at one moment. `failed` carries no cause: the
 * cause goes to diagnostic capture, and the screen says only that the list could not be read.
 */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly SessionDirectoryEntry[] }
  | { readonly status: "failed" };

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

/** This window's staleness counts, advanced by `requestSessionDirectoryRead`. */
export const sessionDirectoryStaleness: SessionDirectoryStaleness = new SessionDirectoryStaleness();

/**
 * Ask every view reading the service's directory to read it again. For a settled act whose answer
 * already implies the list changed; it coalesces nothing.
 */
export function requestSessionDirectoryRead(read: SessionDirectoryReadCall): void {
  sessionDirectoryStaleness.declareStale(read);
}

/**
 * The session ids a view should offer: the directory's, then any open session it does not name.
 *
 * A union, because the directory may not yet name a session this window just created and the
 * open set names only what this window opened. Directory-first keeps the order stable as the
 * directory grows.
 */
export function offeredSessionIds(
  directory: SessionDirectoryState,
  openSessionIds: readonly string[],
): readonly string[] {
  if (directory.status !== "served") {
    return openSessionIds;
  }
  const offered = directory.sessions.map((session) => session.sessionId);
  const alreadyOffered = new Set(offered);
  return [...offered, ...openSessionIds.filter((sessionId) => !alreadyOffered.has(sessionId))];
}
