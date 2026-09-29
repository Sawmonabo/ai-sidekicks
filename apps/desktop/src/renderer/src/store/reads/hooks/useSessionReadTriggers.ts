import { useEffect, useMemo } from "react";

import { eventTriggersRead, type ReadTriggerTarget } from "../read-triggers.js";
import type { ProjectedSessionEvent } from "../../session/entities/entities.js";
import { useSessionDegradedCause } from "../../session/hooks/useSessionInitialized.js";
import { useSessionStore } from "../../session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "../../session/session-store.js";
import { type SessionStoreState } from "../../session/session-state.js";

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
    timeline: readonly ProjectedSessionEvent[],
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

function selectTimeline(state: SessionStoreState): readonly ProjectedSessionEvent[] {
  return state.timeline;
}
