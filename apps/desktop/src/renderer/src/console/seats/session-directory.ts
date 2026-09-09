// The sessions on this node, as a surface can honestly know them.
//
// Two surfaces ask the same question — the sessions destination lists them, the
// auxiliary context picker offers them — and until this hook neither could ask it
// at all. The only session set the renderer could name was the set this window
// happens to have open, which is a different question with a different answer: a
// node with six sessions and a window that has opened none of them is not an empty
// node.
//
// WHY IT LIVES IN `seats/`, AND NEITHER IN `store/` NOR IN `frame/`
//
// It reads the growth port, and `store/` sits BELOW `bridge/` in the console's
// family DAG precisely so a store cannot reach a wire. `useOpenSessionIds` stays
// where it is and stays the seam for what this WINDOW holds; this is its
// neighbour, not its replacement, and the two surfaces compose them.
//
// That argument puts a floor under it and not a ceiling, and it was authored in
// `frame/` because the frame was its only reader. `seats/` is the LOWEST family
// above `bridge/`, so it is the floor exactly, and the difference matters now that a
// view family lists the node's sessions too: a view family can reach neither
// `frame/session-directory.js`, which is a cross-family deep import, nor
// `frame/index.js`, whose `ConsoleRoot` composes every view family through
// `families.ts` and closes a cycle on the way back.
//
// ONE READ PER SIGNAL, AND NO POLLING
//
// The read is issued from a mount effect and never repeated on a timer. It is,
// however, repeated when something SAYS the answer moved, and that is not the same
// thing: a directory that refreshed itself on a schedule would be a second source of
// session truth running against the event stream the console already subscribes to,
// while a directory that never refreshed at all reports a node that has moved on.
//
// The second failure was the one this console actually had. "A navigation back to the
// surface remounts and re-reads" stopped being true the moment the read moved onto
// the frame-lifetime binding seat: a binding outlives every navigation, so the mount
// effect ran once per WINDOW. A session created on the same node after that — by
// another window, or by an act this one settled — was absent from the all-sessions
// list until the window itself came down.
//
// So the re-read is wired to the same two moments every node-scoped reading in this
// console is wired to, through `store/read/read-triggers.ts` and no second mechanism: the
// mount, and the window regaining focus. `subscribe` is deliberately not routed into
// the generation below, because the mount read IS the subscribe read — routing it
// would put two calls on the wire for one arrival.
//
// AND ONE MORE SIGNAL THAT IS NOT A MOMENT BUT AN ACT. {@link requestSessionDirectoryRead}
// is what a settled act calls when its own answer implies the node's list has changed.
// It is a function of the PORT rather than a member of any one caller's state, because
// the readers are three surfaces in three families and the thing that went stale is
// the node's answer they all read — so one bump reaches every one of them, and a
// caller that holds the port needs nothing else to reach it.
//
// THE THREE STATES ARE THE THREE FACTS, AND NO OTHERS
//
// `reading` is a read in flight — the `not-loaded` kind of nothing. `served` is an
// answer, and an answer with no rows is genuinely `empty`. `unavailable` carries
// the port's refusal, which a surface renders as `not-checked`: the console did not
// ask, because no wire answers. Collapsing any two of them is exactly the
// conflation `Spec-023 §Console Design (Meridian)`'s five kinds of nothing exist to
// prevent.
//
// THE STATE IS SUBJECT-SCOPED, AND THE SUBJECT IS THE PORT
//
// A port is minted once per bridge, so a new one is a new source of session truth —
// the fixture's scenario switch, a reconnect, a second window's own instance — and
// the answer read through the previous one stops being an answer at that instant. A
// hook that cleared its own state from the effect would clear it one commit late:
// the render that installs the new port commits with the previous bridge's list
// still held, and both surfaces paint that list under the new source for exactly one
// frame. A stale list under a fresh source reads as a current one, and nothing about
// it says otherwise.
//
// So the state is held by the console's one subject-scoped holder, addressed DURING
// the render that first sees a new port, and the seed it re-addresses to is
// `reading` — which is the truth about a new source nobody has asked yet. The key
// within the subject is `undefined` because there is none: the port IS the whole
// subject, and one port carries one directory.
//
// The holder also replaces the mounted latch this hook used to carry, and it is a
// stricter guard than the latch was. The publisher it hands out carries the
// addressing it was captured under, so an answer dispatched through a port that has
// since been replaced writes NOWHERE — which is the case the latch could not see at
// all, because it read an unmount and a re-address is not one. After an unmount the
// write lands in a holder React has already unsubscribed from, so nothing reaches a
// retired tree; either way the late answer is off the screen rather than on it, and
// neither arm has to remember to read a boolean first.
//
// AND THE READ HAS TWO CHANNELS, NOT ONE
//
// Every growth-port operation is typed to RESOLVE to an outcome, and every port in
// this build does. A promise carries a rejection channel regardless, and reading only
// the fulfilment arm is not a bet that the port keeps its word — it is a state
// machine with no transition out of `reading`, so a port that rejects for any reason
// at all leaves the surface saying "still reading" for the life of the mount, with
// nothing on screen that could ever say otherwise.
//
// SETTLED BY `bridge/readings/read-settlement.ts`, WHICH IS WHERE THAT ARM LIVES FOR
// EVERY READ ON THIS SEAM. This hook once attached its own rejection handler and
// built the refusal through the port's `growthUnavailableFromRejection`, which stamps
// the port's own `call-rejected` and composes a sentence around the daemon's. The
// three sibling reads a family up settle through the reading layer, which keeps the
// daemon's dotted code and its message verbatim — so one surface rendered
// `call-rejected` while another, one navigation later, rendered
// `workflow.session_not_found` for the same class of failure. Two vocabularies for
// one seam is exactly what the reading layer was written to end, and a directory read
// is not the exception: what a person acts on is what the daemon said.

import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { Unsubscribe } from "@ai-sidekicks/contracts";

import type { TransportReconnectObservable } from "../core/index.js";
import {
  useSettledGrowthRead,
  type GrowthPort,
  type GrowthSessionSummary,
  type SettledReadRefusal,
} from "../bridge/index.js";
import {
  NO_TRIGGERING_EVENT_KINDS,
  useWindowReadTriggers,
  type ReadTriggerTarget,
  type RefreshReason,
} from "../store/index.js";

/** What a surface knows about the node's sessions at one moment. */
export type SessionDirectoryState =
  | { readonly status: "reading" }
  | { readonly status: "served"; readonly sessions: readonly GrowthSessionSummary[] }
  | { readonly status: "unavailable"; readonly refusal: SettledReadRefusal };

/** What the directory read settles to, either kind. */
type SettledSessionDirectory = Awaited<ReturnType<GrowthPort["sessionList"]>> | SettledReadRefusal;

/**
 * The read this hook puts, which is always askable.
 *
 * `useSettledGrowthRead` lets a caller answer `undefined` where its wire's request
 * cannot be formed; the directory's request carries nothing, so there is always a
 * question and this always answers a promise. Written as a named function rather than
 * inline so the hook call below reads as the four decisions it is making.
 */
function readDirectory(growth: GrowthPort): ReturnType<GrowthPort["sessionList"]> {
  return growth.sessionList({});
}

/** The directory, given its one read's settlement. */
function settledDirectoryState(settlement: SettledSessionDirectory): SessionDirectoryState {
  return settlement.status === "served"
    ? { status: "served", sessions: settlement.value }
    : { status: "unavailable", refusal: settlement };
}

/**
 * How many times this node's directory has been declared stale, per port.
 *
 * DELIBERATELY NOT A SUBJECT-SCOPED HOLDER AND NOT A GENERATION LATCH, which are the
 * two things `store/subject-scoped/subject-scoped-state.ts` and `store/read/generation-latch.ts` already
 * are and which no third module may become. It holds no value addressed by a subject —
 * the answer stays in the holder, where it belongs — and it gates no settlement, so a
 * late read is not something it has an opinion about. What it counts is how many times
 * somebody said this node's list moved, which is a fact about the NODE rather than
 * about any round of any caller's. The name says that rather than borrowing the
 * vocabulary of the two chokepoints, which is what a reviewer reads for.
 *
 * A class with private fields rather than a module-level `Map`, on the rule
 * `apps/desktop/AGENTS.md` §State and views states and the precedent
 * `seats/surface/absorbed-surfaces.ts` sets one file over: module scope is WINDOW scope here,
 * since an auxiliary window is its own renderer process and no channel joins two
 * windows' module graphs.
 *
 * KEYED ON THE PORT AND NOT ON THE CALLER, because what goes stale is the node's
 * answer rather than any one surface's copy of it. Three surfaces read this directory
 * — the window's attention binding, the auxiliary context picker, and the workflows
 * scope picker — and a count held per caller would leave whichever of them was not the
 * one that asked reading a list from before the act that changed it.
 *
 * A `WeakMap` rather than a `Map` because the key is the whole lifetime: a superseded
 * bridge's port is unreachable the moment the provider drops it, and its count goes
 * with it rather than accumulating one entry per scenario swap for the life of the
 * window. A port nobody has declared stale has no entry at all, which reads as zero —
 * the revision a first mount is answered under.
 */
class SessionDirectoryStaleness {
  readonly #revisionByPort = new WeakMap<GrowthPort, number>();
  readonly #watchersByPort = new WeakMap<GrowthPort, Set<() => void>>();

  /** How many times this port's directory has been declared stale. Zero until one is. */
  public revisionFor(port: GrowthPort): number {
    return this.#revisionByPort.get(port) ?? 0;
  }

  /** Declare this port's directory stale, and wake every surface reading it. */
  public declareStale(port: GrowthPort): void {
    this.#revisionByPort.set(port, this.revisionFor(port) + 1);
    // Over a COPY of the watcher set, so a watcher that releases its handle while
    // being woken does not mutate the set this loop is walking.
    for (const wake of [...(this.#watchersByPort.get(port) ?? [])]) {
      wake();
    }
  }

  /** Watch one port's revision. The returned handle is terminal for its watcher. */
  public watch(port: GrowthPort, wake: () => void): Unsubscribe {
    const watchers = this.#watchersByPort.get(port) ?? new Set<() => void>();
    watchers.add(wake);
    this.#watchersByPort.set(port, watchers);
    return () => {
      watchers.delete(wake);
    };
  }
}

/** This window's readings. Not exported: the hook and the door below are the way in. */
const sessionDirectoryStaleness = new SessionDirectoryStaleness();

/**
 * Ask every surface reading this node's directory to read it again.
 *
 * FOR A SETTLED ACT AND NOT FOR A PRESS. What makes this honest is that the caller
 * already knows the node's answer changed — a join that settled carries the session it
 * joined — so the read it schedules is a read of something that has happened. A press
 * would be a guess: the act is still in flight, and the list it re-read would be the
 * one from before it.
 *
 * It coalesces nothing and arms nothing. One call is one generation, and the readers
 * put one call each; the reasons this console re-reads on a SCHEDULE all travel
 * through `store/read/refresh-scheduler.ts`, and none of them is this.
 */
export function requestSessionDirectoryRead(growth: GrowthPort): void {
  sessionDirectoryStaleness.declareStale(growth);
}

/**
 * Read the node's session directory, for as long as the caller is mounted.
 *
 * The effect is keyed on the port, which is minted once per bridge and therefore
 * stable for the life of a window — so a re-render never re-reads, and a bridge
 * swapped underneath (the fixture's scenario switch) does. The holder is addressed
 * DURING the render that first sees a new port, so the pass that installs one already
 * reads `reading` and no committed frame carries the previous bridge's list under it;
 * the key is `undefined` because the port is the whole subject.
 *
 * THE REVISION IS NOT THE SUBJECT, and the difference is what a person sees. A stale
 * directory re-reads over the SAME address, so the answer already on screen stays
 * there until the new one lands; re-addressing the holder instead would re-seed to
 * `reading` and blank a list on every focus.
 *
 * THE WINDOW HALF OF THE TRIGGER SET AND NOT THE SESSION HALF, on the rule
 * `store/read/read-triggers.ts` states: this read is addressed at the NODE, so no one
 * session's repair and no one session's timeline bear on it, and it declares no
 * triggering event kinds because nothing in one session's timeline says the node's
 * list moved. The transport signal is the caller's because it is the BRIDGE's: this
 * hook holds a port and a port carries no reconnect, so the one edge a node-wide list
 * has to re-read on arrives as a parameter rather than as a signal invented here.
 */
export function useSessionDirectory(
  growth: GrowthPort,
  transportReconnect: TransportReconnectObservable,
): SessionDirectoryState {
  const watchDirectoryRevision = useCallback(
    (wake: () => void) => sessionDirectoryStaleness.watch(growth, wake),
    [growth],
  );
  const readDirectoryRevision = useCallback(
    () => sessionDirectoryStaleness.revisionFor(growth),
    [growth],
  );
  // A number, so `useSyncExternalStore` compares it by value and a port whose revision
  // has not moved re-renders nothing at all.
  const directoryRevision = useSyncExternalStore(
    watchDirectoryRevision,
    readDirectoryRevision,
    readDirectoryRevision,
  );
  const { value: state } = useSettledGrowthRead<SettledSessionDirectory, SessionDirectoryState>(
    growth,
    undefined,
    () => readDirectory(growth),
    { unsettled: () => ({ status: "reading" }), settled: settledDirectoryState },
    directoryRevision,
  );
  useWindowReadTriggers(
    useMemo<ReadTriggerTarget>(
      () => ({
        triggeringEventKinds: NO_TRIGGERING_EVENT_KINDS,
        requestRead: (reason: RefreshReason): void => {
          // `subscribe` is the read the hook above already put on this mount. Routing
          // it into the revision would put a second call on the wire for one arrival —
          // and on every surface, since each holds its own answer.
          if (reason === "subscribe") {
            return;
          }
          sessionDirectoryStaleness.declareStale(growth);
        },
      }),
      [growth],
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
