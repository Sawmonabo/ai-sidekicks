import { useEffect, useMemo } from "react";

import { eventTriggersRead, isRepairEdge, type ReadTriggerTarget } from "../read-triggers.js";
import type { ProjectedSessionEvent } from "../../session/entities/entities.js";
import { useSessionDegradedCause } from "../../session/hooks/useSessionInitialized.js";
import { useSessionStore } from "../../session/hooks/useOpenSessionStore.js";
import { type SessionStore } from "../../session/session-store.js";
import { type SessionStoreState } from "../../session/session-state.js";

/**
 * The two triggers that are properties of one session: the repair edge and the transcript.
 *
 * Both stores are subscribed to in the render body and examined in an effect, because
 * advancing a memory is a mutation that would run twice under strict double-invoke and again on
 * every discarded pass. Wired alone by a reading whose own open is its first read, so mounting
 * and regaining focus do not re-open a live stream and blank what it has delivered.
 */
export function useSessionReadTriggers(
  reader: ReadTriggerTarget,
  sessionStore: SessionStore,
): void {
  // Minted per reading and per session: either moving is a new question, and a memory that
  // outlived one would answer out of the old one's history.
  const memory = useMemo(() => new ReadTriggerMemory(), [reader, sessionStore]);

  const degradedCause = useSessionDegradedCause(sessionStore);
  useEffect(() => {
    if (memory.observeRepair(degradedCause)) {
      reader.requestRead("reconnect");
    }
  }, [degradedCause, memory, reader]);

  // Destructured for the dependency, not the call: the examination reads the whole target, and
  // this re-runs the effect for a reading whose declared set is a getter over something that
  // moves.
  const { triggeringEventKinds } = reader;
  const transcript = useSessionStore(sessionStore, selectTranscript);
  useEffect(() => {
    if (memory.observeTranscript(transcript, reader)) {
      reader.requestRead("terminal-event");
    }
  }, [memory, reader, transcript, triggeringEventKinds]);
}

/**
 * Everything one trigger set remembers about one reading of one session. One class because the
 * repair flag and the cursor are minted and discarded together: a flag carried across a rebind
 * reads as a repair nothing repaired, and a cursor carried across one suppresses the new
 * session's first re-read.
 */
class ReadTriggerMemory {
  #previousCause: string | undefined = undefined;
  #examinedThroughSequence = -1;
  #latestSignalSequence = -1;
  #requestedThroughSequence = -1;

  /** True exactly on the pass where a standing cause became none. */
  public observeRepair(degradedCause: string | undefined): boolean {
    const isRepaired = isRepairEdge(this.#previousCause, degradedCause);
    this.#previousCause = degradedCause;
    return isRepaired;
  }

  /**
   * Examines the newly appended tail and answers whether it owes a re-read. The three sequence
   * numbers are one invariant: the newest signal is meaningful only relative to how far the
   * transcript has been examined, and re-requesting a signal already requested is the re-read
   * loop this cursor stops.
   */
  public observeTranscript(
    transcript: readonly ProjectedSessionEvent[],
    target: ReadTriggerTarget,
  ): boolean {
    for (let position = transcript.length - 1; position >= 0; position -= 1) {
      const entry = transcript[position];
      if (entry === undefined || entry.sequence <= this.#examinedThroughSequence) {
        break;
      }
      // The whole target, so this memory and the imperative wiring beside it admit a frame by
      // the same rule, including the frame-level half a kind set cannot carry.
      if (eventTriggersRead(target, entry) && entry.sequence > this.#latestSignalSequence) {
        this.#latestSignalSequence = entry.sequence;
      }
    }
    const newest = transcript.at(-1);
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

function selectTranscript(state: SessionStoreState): readonly ProjectedSessionEvent[] {
  return state.transcript;
}
