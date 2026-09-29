// The sessions on this node, as a surface can honestly know them.
//
// The set this window has open is a different question with a different answer from
// the node's directory: a node with six sessions and a window that has opened none of
// them is not an empty node. This hook reads the directory, and `useOpenSessionIds`
// stays the seam for what this WINDOW holds.
//
// The call that lists the sessions is the caller's, taken as an argument, so this
// module keeps only its own logic: when to read again, and how the answer is held.
//
// ONE READ PER SIGNAL, AND NO POLLING
//
// The read is issued from a mount effect and never repeated on a timer. It is
// repeated when something SAYS the answer moved: the mount, the window regaining
// focus, and a reconnect, through `store/read/read-triggers.ts` and no second
// mechanism. `subscribe` is deliberately not routed into the revision below, because
// the mount read IS the subscribe read.
//
// AND ONE MORE SIGNAL THAT IS NOT A MOMENT BUT AN ACT. {@link requestSessionDirectoryRead}
// is what a settled act calls when its own answer implies the node's list has
// changed. It is keyed on the call rather than on any one caller's state, because
// what went stale is the node's answer every reader of that call holds.
//
// THE STATE IS SUBJECT-SCOPED, AND THE SUBJECT IS THE CALL
//
// A new call is a new source of session truth, and the answer read through the
// previous one stops being an answer at that instant. The state is held by the
// console's one subject-scoped holder, addressed DURING the render that first sees a
// new call, and re-seeded to `reading`. The key within the subject is `undefined`
// because the call IS the whole subject. An answer dispatched through a call that has
// since been replaced writes NOWHERE.

import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { Unsubscribe } from "@shared/preload-api.js";

import type { TransportReconnectObservable } from "@renderer/lib/transport-reconnect.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useWindowReadTriggers,
  type ReadTriggerTarget,
} from "@renderer/console/store/read/read-triggers.js";
import { useSubjectRead, type SubjectReadProjection } from "@renderer/hooks/useSubjectRead.js";
import { type RefreshReason } from "@renderer/lib/reads/refresh-scheduler.js";

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

/** What a surface knows about the node's sessions at one moment. */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly SessionDirectoryEntry[] };

/**
 * How many times each call's directory has been declared stale.
 *
 * DELIBERATELY NOT A SUBJECT-SCOPED HOLDER AND NOT A GENERATION LATCH, which are the
 * two things `store/subject-scoped/subject-scoped-state.ts` and
 * `store/read/generation-latch.ts` already are and which no third module may become.
 * It holds no value addressed by a subject and it gates no settlement. What it counts
 * is how many times somebody said this node's list moved, which is a fact about the
 * NODE rather than about any round of any caller's.
 *
 * A class with private fields rather than a module-level `Map`, on the state-and-views
 * rule in `apps/desktop/AGENTS.md`. A `WeakMap` rather than a `Map` because the key is
 * the whole lifetime: a superseded call is unreachable and its count goes with it.
 */
class SessionDirectoryStaleness {
  readonly #revisionByCall = new WeakMap<SessionDirectoryReadCall, number>();
  readonly #watchersByCall = new WeakMap<SessionDirectoryReadCall, Set<() => void>>();

  /** How many times this call's directory has been declared stale. Zero until one is. */
  public revisionFor(call: SessionDirectoryReadCall): number {
    return this.#revisionByCall.get(call) ?? 0;
  }

  /** Declare this call's directory stale, and wake every surface reading it. */
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

/** This window's readings. Not exported: the hook and the door below are the way in. */
const sessionDirectoryStaleness = new SessionDirectoryStaleness();

/** `reading` until the node answers, then the sessions it listed. */
const SESSION_DIRECTORY_PROJECTION: SubjectReadProjection<
  readonly SessionDirectoryEntry[],
  SessionDirectoryState
> = {
  unsettled: () => ({ status: "reading" }),
  settled: (sessions) => ({ status: "served", sessions }),
};

/**
 * Ask every surface reading this node's directory to read it again.
 *
 * FOR A SETTLED ACT AND NOT FOR A PRESS. What makes this honest is that the caller
 * already knows the node's answer changed, so the read it schedules is a read of
 * something that has happened. It coalesces nothing and arms nothing.
 */
export function requestSessionDirectoryRead(read: SessionDirectoryReadCall): void {
  sessionDirectoryStaleness.declareStale(read);
}

/**
 * Read the node's session directory, for as long as the caller is mounted.
 *
 * The effect is keyed on the call, so a re-render never re-reads and a replaced call
 * does. THE REVISION IS NOT THE SUBJECT: a stale directory re-reads over the SAME
 * address, so the answer already on screen stays there until the new one lands.
 *
 * THE WINDOW HALF OF THE TRIGGER SET AND NOT THE SESSION HALF, on the rule
 * `store/read/read-triggers.ts` states: this read is addressed at the NODE, so no one
 * session's repair and no one session's timeline bear on it. The transport signal is
 * the caller's because it is the BRIDGE's.
 *
 * A rejected call is not caught here: the effect discards the promise, so the rejection
 * reaches the host as an unhandled rejection and the state stays `reading`.
 */
export function useSessionDirectory(
  read: SessionDirectoryReadCall,
  transportReconnect: TransportReconnectObservable,
): SessionDirectoryState {
  const watchDirectoryRevision = useCallback(
    (wake: () => void) => sessionDirectoryStaleness.watch(read, wake),
    [read],
  );
  const readDirectoryRevision = useCallback(
    () => sessionDirectoryStaleness.revisionFor(read),
    [read],
  );
  // A number, so `useSyncExternalStore` compares it by value and a call whose revision
  // has not moved re-renders nothing at all.
  const directoryRevision = useSyncExternalStore(
    watchDirectoryRevision,
    readDirectoryRevision,
    readDirectoryRevision,
  );
  const { value: state } = useSubjectRead(
    read,
    undefined,
    (_key, signal) => read(signal),
    SESSION_DIRECTORY_PROJECTION,
    directoryRevision,
  );
  useWindowReadTriggers(
    useMemo<ReadTriggerTarget>(
      () => ({
        triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
        requestRead: (reason: RefreshReason): void => {
          // `subscribe` is the read the subject read above already put on this mount.
          // Routing it into the revision would put a second call on the wire for one
          // arrival.
          if (reason === "subscribe") {
            return;
          }
          sessionDirectoryStaleness.declareStale(read);
        },
      }),
      [read],
    ),
    transportReconnect,
  );
  return state;
}

/**
 * The session ids a surface should offer, directory first and this window's own
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
