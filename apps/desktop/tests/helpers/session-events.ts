// One admitted session event, built once for every suite that needs one.
//
// One builder because copies drift invisibly: a fixed `occurredAt` gives every event the same
// instant so nothing ordered by time can be tested, and one derived from the sequence disagrees
// with it. The payload is omitted rather than emptied when a caller supplies none, since a
// projector reading `event.payload?.[member]` treats the two as different events.

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/**
 * One admitted event of the given kind, numbered so a store's cursor moves.
 *
 * `sessionId` is explicit rather than read off a store, because some suites hold a
 * `SessionStore` and others hold none; a caller with a store passes `sessionStore.sessionId`.
 */
export function eventOfKind(
  sessionId: string,
  kind: ProjectedSessionEvent["kind"],
  sequence: number,
  payload?: Readonly<Record<string, unknown>>,
): ProjectedSessionEvent {
  return {
    id: `event-${String(sequence)}`,
    sessionId,
    sequence,
    kind,
    occurredAt: occurredAtFor(sequence),
    ...(payload === undefined ? {} : { payload }),
  };
}

/**
 * The instant an event at `sequence` occurred, one second apart and clamped to the day.
 *
 * Derived so a burst of events can be ordered, since a shared literal makes every comparison a
 * tie. Clamped so an unsafe sequence yields an event and not an `Invalid Date`.
 */
function occurredAtFor(sequence: number): string {
  const startOfDay = Date.UTC(2026, 0, 1);
  const secondsIntoDay = Number.isSafeInteger(sequence) ? Math.min(Math.abs(sequence), 86_399) : 0;
  return new Date(startOfDay + secondsIntoDay * 1000).toISOString();
}
