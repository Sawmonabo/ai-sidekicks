// The four moments a console reading re-reads, wired once for every reading.
//
// A READING IS NOT A SUBSCRIPTION. Every read this console performs answers a
// question at one instant, and four things make that answer stale: a surface
// arriving that has never had one, the window coming back after time passed
// elsewhere, a stream that went away and came back, and an event in this session's
// own timeline saying the answer changed. Each reading used to wire whichever
// subset its author remembered — the approvals reader had all four, the
// driver-capability read had three split across two hooks that each held their own
// copy of the memory, and the queue and quota readings had none at all, so a list
// read once at mount stayed on screen through a reconnect with nothing saying it
// was old.
//
// THE VOCABULARY IS `RefreshReason`'S AND THE COALESCING IS `RefreshScheduler`'S.
// This module wires and schedules nothing itself: a reading hands it the one method
// that puts a reason into its own scheduler, and the scheduler decides what that
// costs. What this module adds is that the wiring has ONE home, so a reading added
// later cannot quietly ship with two of the four.
//
// WHERE THE REPAIR EDGE IS DETECTED. Here, and only here. The console used to carry
// a `SessionRepairWatcher` in the bridge family that two callers each held their own
// instance of; this family sits BELOW that one in the module DAG, so importing it
// would have been exactly the upward edge the structure gate refuses. Rather than
// keep a second copy of a four-line flip, the flip moved into this module's own
// memory — beside the timeline cursor it is minted and discarded with, because they
// are one memory of one session's history — and the bridge module was deleted.

import { useEffect, useMemo } from "react";

import type { ConsoleSessionEvent } from "./entities.js";
import { useSessionDegradedCause, useSessionStore } from "./hooks.js";
import type { RefreshReason } from "./scheduling.js";
import type { SessionStore, SessionStoreState } from "./session-store.js";

/**
 * What a trigger set needs of the reading it refreshes.
 *
 * Two members and no more: a reading is free to be a class held in a registry, a
 * cache keyed by bridge, or a hook's own object, and this module deliberately knows
 * which of those none of them is.
 */
export interface ReadTriggerTarget {
  /**
   * The session-event kinds whose arrival owes this reading a fresh read.
   *
   * DECLARED BY THE READING and not passed by the surface that mounts it, because
   * which events change an answer is a property of the QUESTION: two surfaces asking
   * the same one must not disagree about when it goes stale. An empty set is a real
   * answer rather than an omission — a reading whose own live tail is the authority
   * for what it holds learns nothing from the timeline, and says so.
   */
  readonly triggeringEventKinds: ReadonlySet<string>;
  /**
   * Whether THIS frame, of an already-declared kind, owes this reading a read.
   *
   * OPTIONAL, AND ITS ABSENCE IS THE DEFAULT RATHER THAN AN OMISSION: a reading whose
   * question is answered by the kind alone declares nothing here and every frame of a
   * declared kind reaches it, which is what every reading in the tree did before this
   * member existed.
   *
   * IT EXISTS BECAUSE A KIND IS NOT ALWAYS THE WHOLE QUESTION. A session runs many
   * workflows, and every one of the workflow plane's twenty-four kinds is emitted for
   * whichever run the engine advanced — so a run pane declaring the kinds re-read on
   * every OTHER run's phases too, once per pane, for as long as anything in the session
   * was moving. The subject the reading is addressed at is the missing half, and it is
   * a property of the READING rather than of the wiring, which is why it is declared
   * here beside the kinds and not passed in at either call site.
   *
   * A PREDICATE AND NOT A NARROWER KIND SET, because the two answer different
   * questions: which kinds can change this answer at all is static, and which FRAMES
   * changed it is per frame. Fusing them would mean a reading whose subject moved had
   * to re-declare a set, and the set is what two readings asking the same question must
   * agree on.
   */
  admitsTriggeringEvent?(event: ConsoleSessionEvent): boolean;
  /** Ask for a read. Coalescing, debouncing, and the call itself are the reading's. */
  requestRead(reason: RefreshReason): void;
}

/**
 * Whether one admitted frame owes `target` a read: the declared kind, then the frame.
 *
 * ONE PREDICATE FOR BOTH WIRINGS. `useSessionReadTriggers` below and
 * `SessionRefreshTriggers` beside it wire the same policy for two kinds of reading —
 * one mounted by React, one minted in a resource seam — and the comment at the head of
 * that module states the rule they are held to: two wirings are honest and two
 * VOCABULARIES are not. A reading whose frame-level admission was consulted by one of
 * them and not the other would go stale on exactly the surfaces wired the other way,
 * which is a defect no test of either module alone would report.
 *
 * The kind is checked FIRST and the predicate only after, so a reading pays the cost of
 * reading a payload only for frames it had already declared an interest in.
 */
export function eventTriggersRead(target: ReadTriggerTarget, event: ConsoleSessionEvent): boolean {
  if (!target.triggeringEventKinds.has(event.kind)) {
    return false;
  }
  return target.admitsTriggeringEvent?.(event) ?? true;
}

/**
 * The empty declaration, named once so four readings share one frozen set.
 *
 * A reading whose stream already carries every change it folds names this, and the
 * name is the claim: nothing in the timeline tells it something its own tail did not.
 */
export const NO_TRIGGERING_EVENT_KINDS: ReadonlySet<string> = Object.freeze(new Set<string>());

/**
 * Everything one trigger set remembers about one reading of one session.
 *
 * One class rather than a flag beside a cursor, because they are minted and
 * discarded together and for the same reason: a repair flag carried across a rebind
 * reads as a repair nothing repaired, and a cursor carried across one suppresses the
 * new session's first re-read. Both are memories of a session's history, so both die
 * with the pair they were taken under.
 */
class ReadTriggerMemory {
  #wasDegraded = false;
  #examinedThroughSequence = -1;
  #latestSignalSequence = -1;
  #requestedThroughSequence = -1;

  /** True exactly on the pass where a standing cause became none. */
  public observeRepair(degradedCause: string | undefined): boolean {
    const isDegraded = degradedCause !== undefined;
    const isRepaired = this.#wasDegraded && !isDegraded;
    this.#wasDegraded = isDegraded;
    return isRepaired;
  }

  /**
   * Examine the newly appended tail and answer whether it owes a re-read.
   *
   * The three sequence numbers are one invariant: the newest signal is only
   * meaningful relative to how far the timeline has been examined, and asking again
   * for a signal already requested is the re-read loop this cursor exists to stop.
   */
  public observeTimeline(
    timeline: readonly ConsoleSessionEvent[],
    target: ReadTriggerTarget,
  ): boolean {
    for (let position = timeline.length - 1; position >= 0; position -= 1) {
      const entry = timeline[position];
      if (entry === undefined || entry.sequence <= this.#examinedThroughSequence) {
        break;
      }
      // The whole target rather than its kind set, so this memory and the imperative
      // wiring beside it admit a frame by the same rule — including the frame-level
      // half, which a kind set alone cannot carry.
      if (eventTriggersRead(target, entry) && entry.sequence > this.#latestSignalSequence) {
        this.#latestSignalSequence = entry.sequence;
      }
    }
    const newest = timeline.at(-1);
    if (newest !== undefined) {
      this.#examinedThroughSequence = Math.max(this.#examinedThroughSequence, newest.sequence);
    }
    if (this.#latestSignalSequence <= this.#requestedThroughSequence) {
      return false;
    }
    this.#requestedThroughSequence = this.#latestSignalSequence;
    return true;
  }
}

function selectTimeline(state: SessionStoreState): readonly ConsoleSessionEvent[] {
  return state.timeline;
}

/**
 * The two triggers that are properties of the WINDOW rather than of a session.
 *
 * A node-scoped reading — this node's provider accounts, this node's declared driver
 * capabilities — wires exactly these: it holds no session, so no session's repair and
 * no session's timeline bear on it, and pretending otherwise would tie one node-wide
 * answer to whichever session happened to be open.
 */
export function useWindowReadTriggers(reader: ReadTriggerTarget): void {
  useEffect(() => {
    // In an effect and not in the render body: a render React discards would
    // otherwise put a call on the wire for a surface nobody ever saw.
    reader.requestRead("subscribe");
  }, [reader]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onWindowFocused = (): void => {
      reader.requestRead("window-focus");
    };
    window.addEventListener("focus", onWindowFocused);
    return () => {
      window.removeEventListener("focus", onWindowFocused);
    };
  }, [reader]);
}

/**
 * The two triggers that are properties of one SESSION.
 *
 * Both stores are subscribed to in the render body and EXAMINED in an effect, which
 * is the same rule twice: reading a store through its selector is what a render
 * does, and advancing a memory is a mutation — one that runs twice under React's
 * strict double-invoke and once more on every pass React discards.
 *
 * Wired alone by a reading whose own open is its first read, so that mounting and
 * regaining focus do not re-open a live stream and blank what it has already
 * delivered.
 */
export function useSessionReadTriggers(
  reader: ReadTriggerTarget,
  sessionStore: SessionStore,
): void {
  // Minted per reading AND per session: either moving is a new question, and a
  // memory that outlived one would answer the new one out of the old one's history.
  const memory = useMemo(() => new ReadTriggerMemory(), [reader, sessionStore]);

  const degradedCause = useSessionDegradedCause(sessionStore);
  useEffect(() => {
    if (memory.observeRepair(degradedCause)) {
      reader.requestRead("reconnect");
    }
  }, [degradedCause, memory, reader]);

  // Destructured for the DEPENDENCY and not for the call: the examination below reads
  // the whole target, and this is what re-runs the effect for a reading whose declared
  // set is a getter over something that moves while the reading itself is one object.
  const { triggeringEventKinds } = reader;
  const timeline = useSessionStore(sessionStore, selectTimeline);
  useEffect(() => {
    if (memory.observeTimeline(timeline, reader)) {
      reader.requestRead("terminal-event");
    }
  }, [memory, reader, timeline, triggeringEventKinds]);
}

/**
 * All four, for a reading a session owns.
 *
 * The composition and not a fifth implementation: a session-scoped reading is a
 * window-scoped one that also has a session, and stating it that way is what keeps
 * the two halves from drifting into two vocabularies.
 */
export function useReadTriggers(reader: ReadTriggerTarget, sessionStore: SessionStore): void {
  useWindowReadTriggers(reader);
  useSessionReadTriggers(reader, sessionStore);
}
