// One admitted session event, built once for every suite that needs one.
//
// ONE BUILDER, because copies of this literal drift in the two places drift is
// invisible: a copy that spells `occurredAt` as a fixed literal gives every event a
// suite applies the same instant, so nothing ordered by time can be tested at all, and a
// copy that derives it from the sequence disagrees with it. Neither reports the other.
//
// THE PAYLOAD IS OMITTED RATHER THAN EMPTIED when a caller supplies none, because the
// two are different events to a projector that reads `event.payload?.[member]` and
// this helper must not decide for its callers which one they meant.

import type { ProjectedSessionEvent } from "@renderer/store/session/entities/entities.js";

/**
 * One admitted event of the given kind, numbered so a store's cursor moves.
 *
 * `sessionId` first and explicit rather than read off a store, because the suites that
 * need one are split: the store's own suites hold a `SessionStore` and the reconciler,
 * queue, and degradation suites hold no store at all. A caller with a store passes
 * `sessionStore.sessionId`, which is the same reading one argument earlier.
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
 * Derived rather than fixed so a suite applying a burst gets events that can be
 * ORDERED — a shared literal makes every comparison a tie, which is the one reading a
 * timestamp exists to give. Clamped because a suite reaching for a large or unsafe
 * sequence wants an event, not an `Invalid Date` that fails somewhere else entirely.
 */
function occurredAtFor(sequence: number): string {
  const startOfDay = Date.UTC(2026, 0, 1);
  const secondsIntoDay = Number.isSafeInteger(sequence) ? Math.min(Math.abs(sequence), 86_399) : 0;
  return new Date(startOfDay + secondsIntoDay * 1000).toISOString();
}
