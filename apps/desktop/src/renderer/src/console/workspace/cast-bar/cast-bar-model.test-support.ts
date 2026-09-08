// The three things both halves of the derivation's suite build: a wheel, an event, and
// an event carrying the run identity an ask correlates on.
//
// One module rather than a copy in each, because the two suites derive the SAME model
// from two directions — what one chip says, and what the bar as a whole is — and two
// spellings of "a session with these participants and this log" would let one file pass
// against a derivation the other never builds.

import type { ConsoleSessionEvent } from "../../store/index.js";
import { eventOfKind } from "../../store/session-event.test-support.js";
import { ParticipantHueAllocator } from "../../tokens/index.js";

/** The join-log order every chip roster is derived in, as the allocator's own output. */
export function wheelFor(participantIds: readonly string[]): ParticipantHueAllocator {
  const allocator = new ParticipantHueAllocator();
  for (const participantId of participantIds) {
    allocator.admit(participantId);
  }
  return allocator;
}

/** One admitted event with the actor a chip is derived from, over the shared builder. */
export function castEvent(sequence: number, actorId: string, kind: string): ConsoleSessionEvent {
  return { ...eventOfKind("session-1", kind, sequence), actorId };
}

/** The same event, carrying the run identity an ask's lifecycle correlates on. */
export function withRun(base: ConsoleSessionEvent, runId: string): ConsoleSessionEvent {
  return { ...base, payload: { runId } };
}
