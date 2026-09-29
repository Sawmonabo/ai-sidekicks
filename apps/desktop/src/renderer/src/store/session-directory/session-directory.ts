// The sessions on this node, as a view can honestly know them.
//
// The set this window has open is a different question with a different answer from
// the node's directory: a node with six sessions and a window that has opened none of
// them is not an empty node. `useSessionDirectory` reads the directory, and
// `useOpenSessionIds` stays the seam for what this WINDOW holds. This module holds the
// directory's types and how many times each call's answer went stale.
//
// ONE READ PER SIGNAL, AND NO POLLING
//
// The read is issued from a mount effect and never repeated on a timer. It is
// repeated when something SAYS the answer moved: the mount, the window regaining
// focus, and a reconnect, through `store/reads/read-triggers.ts` and no second
// mechanism. `subscribe` is deliberately not routed into the revision below, because
// the mount read IS the subscribe read.
//
// AND ONE MORE SIGNAL THAT IS NOT A MOMENT BUT AN ACT. {@link requestSessionDirectoryRead}
// is what a settled act calls when its own answer implies the node's list has
// changed. It is keyed on the call rather than on any one caller's state, because
// what went stale is the node's answer every reader of that call holds.
//
import type { Unsubscribe } from "@shared/preload-api.js";

/** One session the node lists. A session with no title is shown by its identifier. */
export interface SessionDirectoryEntry {
  readonly sessionId: string;
  readonly title?: string;
  readonly state: string;
}

/**
 * The call that lists the node's sessions.
 */
export type SessionDirectoryReadCall = (
  signal: AbortSignal,
) => Promise<readonly SessionDirectoryEntry[]>;

/** What a view knows about the node's sessions at one moment. */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly SessionDirectoryEntry[] };

/**
 * How many times each call's directory has been declared stale.
 *
 * DELIBERATELY NOT A SUBJECT-SCOPED HOLDER AND NOT A GENERATION LATCH, which are the
 * two things `lib/subject-scoped/subject-scoped-holder.ts` and
 * `lib/reads/generation-latch.ts` already are and which no third module may become.
 * It holds no value addressed by a subject and it gates no settlement. What it counts
 * is how many times somebody said this node's list moved, which is a fact about the
 * NODE rather than about any round of any caller's.
 *
 * A class with private fields rather than a module-level `Map`, on the state-and-views
 * rule in `apps/desktop/AGENTS.md`. A `WeakMap` rather than a `Map` because the key is
 * the whole lifetime: a superseded call is unreachable and its count goes with it.
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
    // Over a COPY of the watcher set, so a watcher that releases its handle while
    // being woken does not mutate the set this loop is walking.
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
 * This window's staleness counts: advanced by {@link requestSessionDirectoryRead} and
 * read by the directory hook, and by nothing else.
 */
export const sessionDirectoryStaleness: SessionDirectoryStaleness = new SessionDirectoryStaleness();

/**
 * Ask every view reading this node's directory to read it again.
 *
 * FOR A SETTLED ACT AND NOT FOR A PRESS. What makes this honest is that the caller
 * already knows the node's answer changed, so the read it schedules is a read of
 * something that has happened. It coalesces nothing and arms nothing.
 */
export function requestSessionDirectoryRead(read: SessionDirectoryReadCall): void {
  sessionDirectoryStaleness.declareStale(read);
}

/**
 * The session ids a view should offer, directory first and this window's own
 * open sessions after.
 *
 * A union rather than a replacement, because the two sets answer to different
 * authorities and either can hold what the other does not. The directory is the
 * node's answer and may not yet name a session this window created a moment ago;
 * the open set is this window's and names nothing it has not opened. Dropping
 * either would make a session disappear from a list it is genuinely on.
 *
 * Order is directory-first so the list a person reads is the node's, with anything
 * only this window knows about appended rather than interleaved — an ordering
 * that stays stable as the directory grows.
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
